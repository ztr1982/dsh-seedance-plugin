/**
 * dsh-seedance — 让模型在对话里调用 Seedance（火山方舟）生成视频。
 *
 * 设计要点：
 *  - 提交即返回 + 有界等待（默认 90s），不做长时间阻塞；
 *  - 成功后立即下载（Ark 视频 URL 有时效）；
 *  - 幂等：15 分钟内同参数复用 taskId，避免重复扣费；
 *  - 媒体路由只暴露本地任务表里登记过的文件，且仅限回环地址。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { join, isAbsolute, resolve, extname } from 'node:path'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'

import {
  normalizeParams, buildFileName, RESOLUTIONS, RATIOS, PRESET_NAMES,
} from './lib/params.js'
import {
  buildBody, createTask, getTask, cancelTask,
  mapStatus, extractVideoUrl, extractError, ArkError, sleep,
} from './lib/ark.js'
import { TaskStore } from './lib/store.js'
import { downloadVideo } from './lib/download.js'
import { createMediaHandler, hostIsLoopback, DEFAULT_MEDIA_ROUTE } from './lib/media.js'
import {
  readJsonFile, writeJsonFile, maskKey, effectiveSettings,
  usageSummary, seedanceModels, modelNotes,
} from './lib/settings.js'
import { DEFAULT_PROMPT } from './lib/prompt.js'

export const name = 'dsh-seedance'
// workingDirectory：会话工作区（落盘路径）；webServer：播放路由
export const inject = ['tools', 'webServer', 'workingDirectory']

const CONFIG_DEFAULTS = {
  apiKey: '',
  baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  preset: 'standard',
  model: '',
  outputDir: 'outputs/seedance',
  maxResolution: '1080p',
  maxDuration: 10,
  maxPerDay: 20,
  defaultWaitSec: 90,
  autoDownload: true,
  promptEnabled: true,
}

export const Config = Schema.object({
  apiKey: Schema.string().default(''),
  baseUrl: Schema.string().default(CONFIG_DEFAULTS.baseUrl),
  preset: Schema.string().default(CONFIG_DEFAULTS.preset),
  model: Schema.string().default(''),
  outputDir: Schema.string().default(CONFIG_DEFAULTS.outputDir),
  maxResolution: Schema.string().default(CONFIG_DEFAULTS.maxResolution),
  maxDuration: Schema.number().default(CONFIG_DEFAULTS.maxDuration),
  maxPerDay: Schema.number().default(CONFIG_DEFAULTS.maxPerDay),
  defaultWaitSec: Schema.number().default(CONFIG_DEFAULTS.defaultWaitSec),
  autoDownload: Schema.boolean().default(CONFIG_DEFAULTS.autoDownload),
  promptEnabled: Schema.boolean().default(CONFIG_DEFAULTS.promptEnabled),
})

// 本地任务一旦到这些状态就不再轮询/取消（远端 status 用 ark.js 的 TERMINAL）
const LOCAL_DONE = new Set(['downloaded', 'succeeded', 'failed', 'cancelled', 'expired'])

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
}

function sha256(input) {
  return createHash('sha256').update(input).digest('hex')
}

function startOfToday() {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
}

function clampWaitSec(value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return Math.max(0, Math.min(240, Number(fallback) || 90))
  return Math.max(0, Math.min(240, Math.round(n)))
}

function resolveDshHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME.trim()
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
}

export function apply(ctx, rawConfig) {
  const defaults = CONFIG_DEFAULTS
  const dataDir = join(resolveDshHome(), 'dsh-seedance')
  const store = new TaskStore(join(dataDir, 'tasks.json'))

  // 独立的密钥文件：不用改 profile 的 YAML。每次调用按 mtime 重读，填完即时生效。
  const configFile = join(dataDir, 'config.json')
  let fileCache = { mtimeMs: -1, value: {} }
  const fileConfig = () => {
    try {
      const stat = statSync(configFile)
      if (stat.mtimeMs !== fileCache.mtimeMs) {
        // Windows 编辑器常带 UTF-8 BOM，JSON.parse 会因此抛错
        const text = readFileSync(configFile, 'utf8').replace(/^\uFEFF/, '')
        try {
          fileCache = { mtimeMs: stat.mtimeMs, value: JSON.parse(text) }
        } catch (error) {
          console.warn(`[dsh-seedance] ${configFile} 不是合法 JSON：${error.message}`)
          fileCache = { mtimeMs: stat.mtimeMs, value: {} }
        }
      }
      return fileCache.value || {}
    } catch {
      return {}
    }
  }

  /** 生效配置：默认值 < profile patch < config.json（面板写这里） */
  const settings = () => effectiveSettings(defaults, rawConfig || {}, fileConfig())

  const apiKey = () => String(settings().apiKey || process.env.ARK_API_KEY || '').trim()
  const baseUrl = () => String(settings().baseUrl || CONFIG_DEFAULTS.baseUrl).replace(/\/+$/, '')

  // ---- 媒体 URL 前缀（webServer 由宿主提供）----
  const webServer = ctx.webServer ?? (typeof ctx.get === 'function' ? ctx.get('webServer') : undefined)
  const port = webServer && Number(webServer.port)
  const mediaBase = port ? `http://127.0.0.1:${port}` : null
  const mediaUrlOf = (id) => (mediaBase ? `${mediaBase}${DEFAULT_MEDIA_ROUTE}/${encodeURIComponent(id)}` : null)

  if (webServer && typeof webServer.register === 'function') {
    try {
      ctx.effect(() => webServer.register({
        kind: 'prefix',
        path: DEFAULT_MEDIA_ROUTE,
        handler: createMediaHandler({ store }),
      }))
    } catch (error) {
      console.warn('[dsh-seedance] 媒体路由注册失败（下载与本地路径仍可用）:', error && error.message)
    }
  }

  // ---- 面板 API：/dsh-seedance/api/*（仅本机回环）----
  const API_ROUTE = '/dsh-seedance/api'
  const CATALOG_TTL = 5 * 60 * 1000
  let catalogCache = { at: 0, value: null }

  function sendJson(res, status, payload) {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
    })
    res.end(body)
  }

  function readJsonBody(req) {
    return new Promise((resolve) => {
      let raw = ''
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      try {
        req.setEncoding && req.setEncoding('utf8')
      } catch { /* 某些请求对象不支持 setEncoding */ }
      req.on('data', (chunk) => {
        raw += chunk
        if (raw.length > 2 * 1024 * 1024) finish(null)
      })
      req.on('end', () => {
        if (!raw) return finish({})
        try { finish(JSON.parse(raw)) } catch { finish(null) }
      })
      req.on('error', () => finish(null))
      if (req.readableEnded) finish({})
    })
  }

  async function fetchCatalog(force = false) {
    const now = Date.now()
    if (!force && catalogCache.value && now - catalogCache.at < CATALOG_TTL) return catalogCache.value
    if (!apiKey()) return null
    const res = await fetch(`${baseUrl()}/models`, {
      headers: { Authorization: `Bearer ${apiKey()}` },
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new ArkError(`拉取模型目录失败（HTTP ${res.status}）${text ? `：${text.slice(0, 200)}` : ''}`, {
        code: 'MODELS_FAILED', status: res.status,
      })
    }
    const data = await res.json()
    catalogCache = { at: now, value: data }
    return data
  }

  function panelState() {
    const effective = settings()
    const key = apiKey()
    const tasks = store.list({ limit: 50 })
    return {
      ok: true,
      config: {
        hasKey: Boolean(key),
        apiKeyMasked: maskKey(key),
        baseUrl: effective.baseUrl,
        model: effective.model,
        preset: effective.preset,
        maxResolution: effective.maxResolution,
        maxDuration: effective.maxDuration,
        maxPerDay: effective.maxPerDay,
        defaultWaitSec: effective.defaultWaitSec,
        outputDir: effective.outputDir,
      },
      usage: usageSummary(store.list({ limit: 500 })),
      tasks: tasks.map((task) => ({
        taskId: task.id,
        status: task.status,
        createdAt: task.createdAt,
        prompt: String(task.prompt || '').slice(0, 200),
        model: (task.params && task.params.model) || '',
        duration: (task.params && task.params.duration) || null,
        resolution: (task.params && task.params.resolution) || null,
        ratio: (task.params && task.params.ratio) || null,
        tokens: (task.usage && task.usage.total_tokens) || null,
        videoPath: task.videoPath || null,
        mediaUrl: task.videoPath ? mediaUrlOf(task.id) : null,
        error: task.error ? { code: task.error.code, message: task.error.message } : null,
      })),
      models: catalogCache.value ? seedanceModels(catalogCache.value) : [],
      modelNotes: modelNotes(store.list({ limit: 500 })),
    }
  }

  async function apiHandler(req, res) {
    if (!hostIsLoopback(req)) {
      sendJson(res, 403, { ok: false, error: '只接受本机请求' })
      return
    }
    const url = new URL(String(req.url || '/'), 'http://localhost')
    const path = url.pathname.slice(API_ROUTE.length) || '/'

    try {
      if (req.method === 'GET' && (path === '/' || path === '/state')) {
        sendJson(res, 200, panelState())
        return
      }

      if (req.method === 'POST' && path === '/config') {
        const body = await readJsonBody(req)
        if (!body) {
          sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
          return
        }
        const next = { ...fileConfig() }
        for (const key of ['baseUrl', 'model', 'preset', 'maxResolution', 'outputDir']) {
          if (typeof body[key] === 'string' && body[key].trim()) next[key] = body[key].trim()
        }
        if (typeof body.apiKey === 'string' && body.apiKey.trim()) next.apiKey = body.apiKey.trim()
        if (body.clearKey === true) delete next.apiKey
        if (body.maxDuration !== undefined) {
          next.maxDuration = Math.max(4, Math.min(15, Math.round(Number(body.maxDuration) || 10)))
        }
        if (body.maxPerDay !== undefined) {
          next.maxPerDay = Math.max(1, Math.min(200, Math.round(Number(body.maxPerDay) || 20)))
        }
        if (body.defaultWaitSec !== undefined) {
          next.defaultWaitSec = Math.max(0, Math.min(240, Math.round(Number(body.defaultWaitSec) || 0)))
        }
        writeJsonFile(configFile, next)
        fileCache = { mtimeMs: -1, value: {} }
        catalogCache = { at: 0, value: null }
        sendJson(res, 200, panelState())
        return
      }

      if (req.method === 'POST' && path === '/test') {
        if (!apiKey()) {
          sendJson(res, 400, { ok: false, error: '还没配置 API Key' })
          return
        }
        const started = Date.now()
        const catalog = await fetchCatalog(true)
        sendJson(res, 200, {
          ok: true,
          latencyMs: Date.now() - started,
          totalModels: Array.isArray(catalog && catalog.data) ? catalog.data.length : 0,
          models: seedanceModels(catalog),
          notes: modelNotes(store.list({ limit: 500 })),
        })
        return
      }

      if (req.method === 'POST' && path === '/models') {
        const catalog = await fetchCatalog(true)
        sendJson(res, 200, {
          ok: true,
          models: seedanceModels(catalog),
          notes: modelNotes(store.list({ limit: 500 })),
        })
        return
      }

      if (req.method === 'POST' && path === '/cancel') {
        const body = await readJsonBody(req)
        const taskId = body && body.taskId ? String(body.taskId) : ''
        const task = taskId ? store.get(taskId) : null
        if (!task) {
          sendJson(res, 404, { ok: false, error: '任务不存在' })
          return
        }
        if (LOCAL_DONE.has(task.status)) {
          sendJson(res, 200, { ok: true, status: task.status, message: '任务已结束' })
          return
        }
        if (!apiKey()) {
          sendJson(res, 400, { ok: false, error: '还没配置 API Key' })
          return
        }
        await cancelTask({ baseUrl: baseUrl(), apiKey: apiKey(), id: taskId })
        store.patch(taskId, { status: 'cancelled', arkStatus: 'cancelled' })
        sendJson(res, 200, { ok: true, status: 'cancelled' })
        return
      }

      sendJson(res, 404, { ok: false, error: 'not found' })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error && error.message ? error.message : String(error), code: error && error.code })
    }
  }

  if (webServer && typeof webServer.register === 'function') {
    try {
      ctx.effect(() => webServer.register({ kind: 'prefix', path: API_ROUTE, handler: apiHandler }))
    } catch (error) {
      console.warn('[dsh-seedance] 面板 API 注册失败:', error && error.message)
    }
  }

  // ---- 系统提示：告诉模型何时该生成、何时必须先问 ----
  if (settings().promptEnabled !== false && typeof ctx.on === 'function') {
    ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembled = await next()
      try {
        assembled.sections.push({ name: 'dsh-seedance', text: DEFAULT_PROMPT })
      } catch { /* 结构不符就跳过，不影响主流程 */ }
      return assembled
    })
  }

  // ---------- 工具函数 ----------

  function fail(code, message, extra = {}) {
    return {
      ok: false,
      status: 'error',
      error: { code, message, retryable: false },
      message,
      ...extra,
    }
  }

  async function workspaceRoot(exec) {
    // 宿主提供 workingDirectory 服务时，以会话工作区为准（bash 工具也用它）
    const service = ctx.workingDirectory
    if (service && typeof service.ensure === 'function' && exec && exec.agent) {
      try {
        const dir = await service.ensure(exec.agent, exec.signal)
        if (typeof dir === 'string' && dir.trim()) return dir
      } catch { /* 服务不可用就退回兜底路径 */ }
    }
    const candidates = [
      exec && exec.workspace && exec.workspace.cwd,
      exec && exec.workspace && exec.workspace.root,
      exec && exec.cwd,
      process.env.DSH_WORKSPACE,
      process.cwd(),
    ]
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) return candidate
    }
    return process.cwd()
  }

  async function outputRoot(exec) {
    const configured = String(settings().outputDir || CONFIG_DEFAULTS.outputDir)
    if (isAbsolute(configured)) return configured
    return join(await workspaceRoot(exec), configured)
  }

  async function resolveImage(input, exec) {
    const raw = String(input || '').trim()
    if (!raw) throw new Error('空图片地址')
    if (/^https?:\/\//i.test(raw)) return raw
    const absolute = isAbsolute(raw) ? raw : resolve(await workspaceRoot(exec), raw)
    if (!existsSync(absolute)) throw new Error(`图片不存在：${absolute}`)
    const stat = statSync(absolute)
    if (!stat.isFile()) throw new Error(`不是文件：${absolute}`)
    if (stat.size > 10 * 1024 * 1024) throw new Error(`图片超过 10MB：${absolute}`)
    const mime = MIME_BY_EXT[extname(absolute).toLowerCase()]
    if (!mime) throw new Error(`不支持的图片格式：${extname(absolute)}`)
    return `data:${mime};base64,${readFileSync(absolute).toString('base64')}`
  }

  function hashRequest(p, images) {
    return sha256(JSON.stringify({
      model: p.model,
      prompt: p.prompt,
      ratio: p.ratio,
      duration: p.duration,
      resolution: p.resolution,
      audio: p.audio,
      watermark: p.watermark,
      images: images.map((item) => (item.startsWith('data:') ? sha256(item) : item)),
    }))
  }

  function applyRemote(task, remote) {
    // 已经落盘的任务不要被远端状态降级（downloaded 是本地特有状态）
    const status = task.status === 'downloaded' ? 'downloaded' : mapStatus(remote && remote.status)
    const videoUrl = extractVideoUrl(remote) || task.videoUrl || null
    const error = extractError(remote)
    return store.patch(task.id, {
      arkStatus: (remote && remote.status) || task.arkStatus,
      status,
      videoUrl,
      error,
      usage: remote && remote.usage,
    }) || task
  }

  async function maybeDownload(task, exec) {
    if (!task || !task.videoUrl) return task
    if (task.videoPath && existsSync(task.videoPath)) return task
    const dest = join(await outputRoot(exec), buildFileName(new Date(task.createdAt || Date.now()), task.params && task.params.name, task.id))
    try {
      await downloadVideo(task.videoUrl, dest, { signal: exec && exec.signal })
      return store.patch(task.id, { status: 'downloaded', videoPath: dest, downloadError: null }) || task
    } catch (error) {
      const message = error && error.message ? error.message : String(error)
      console.warn('[dsh-seedance] 下载失败:', message)
      return store.patch(task.id, { downloadError: message }) || task
    }
  }

  async function poll(task, waitSec, exec) {
    const deadline = Date.now() + Math.max(0, waitSec) * 1000
    let current = task
    let delay = 3000
    let lastCheckError = null

    while (!LOCAL_DONE.has(current.status)) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      await sleep(Math.min(delay, Math.max(500, remaining)), exec && exec.signal)
      try {
        const remote = await getTask({
          baseUrl: baseUrl(), apiKey: apiKey(), id: current.id, signal: exec && exec.signal,
        })
        current = applyRemote(current, remote)
        lastCheckError = null
      } catch (error) {
        if (error && error.code === 'ABORTED') throw error
        lastCheckError = error && error.message ? error.message : String(error)
        if (error && error.status === 404) {
          current = store.patch(current.id, { status: 'failed', error: { code: 'TASK_NOT_FOUND', message: '任务不存在' } }) || current
          break
        }
      }
      delay = Math.min(delay + 2000, 10000)
    }

    if (current.status === 'succeeded' && settings().autoDownload !== false) {
      current = await maybeDownload(current, exec)
    }
    if (lastCheckError && !LOCAL_DONE.has(current.status)) {
      current = store.patch(current.id, { lastCheckError }) || current
    }
    return view(current)
  }

  function view(task, extra = {}) {
    const elapsedSec = Math.max(0, Math.round((Date.now() - (task.createdAt || Date.now())) / 1000))
    const params = task.params || {}
    const detail = [
      params.duration ? `${params.duration}s` : null,
      params.resolution || null,
      params.ratio || null,
      params.audio ? '有声' : null,
    ].filter(Boolean).join(' / ')

    const lines = []
    let ok = true

    if (task.videoPath) {
      lines.push(`✅ 视频已生成并保存（${detail}，用时 ${elapsedSec}s）`)
      lines.push(`本地文件：${task.videoPath}`)
      const media = mediaUrlOf(task.id)
      if (media) lines.push(`播放：${media}`)
    } else if (task.status === 'succeeded') {
      lines.push(`✅ 视频已生成（${detail}，用时 ${elapsedSec}s），但本地下载失败`)
      if (task.downloadError) lines.push(`下载错误：${task.downloadError}`)
      if (task.videoUrl) lines.push(`远端地址（有时效）：${task.videoUrl}`)
    } else if (task.status === 'failed') {
      ok = false
      const reason = (task.error && task.error.message) || '未知原因'
      lines.push(`❌ 生成失败：${reason}`)
      if (task.error && task.error.code) lines.push(`错误码：${task.error.code}`)
      lines.push('建议：参数类错误请调整分辨率/时长/比例；内容类错误请改写提示词后重试。')
    } else if (task.status === 'cancelled') {
      ok = false
      lines.push('🚫 任务已取消')
    } else if (task.status === 'expired') {
      ok = false
      lines.push('⌛ 本地等待超时，任务可能仍在远端生成，可稍后再次 seedance_check')
    } else {
      lines.push(`⏳ 视频生成中（${task.status === 'queued' ? '排队中' : '生成中'}，已等 ${elapsedSec}s）`)
      lines.push(`任务 ID：${task.id}`)
      lines.push('用 seedance_check 查看进度；不要重复提交同样的请求。')
    }

    if (extra.deduped) lines.push('（15 分钟内相同请求，已复用原任务，未重复提交）')
    if (extra.note) lines.push(extra.note)

    return {
      ok,
      status: task.status,
      taskId: task.id,
      model: params.model || null,
      params: {
        ratio: params.ratio || null,
        duration: params.duration || null,
        resolution: params.resolution || null,
        audio: params.audio === true,
        preset: params.preset || null,
      },
      elapsedSec,
      videoPath: task.videoPath || null,
      videoUrl: task.videoUrl || null,
      mediaUrl: task.videoPath ? mediaUrlOf(task.id) : null,
      error: task.error || null,
      deduped: extra.deduped === true,
      message: lines.join('\n'),
      ...(extra.extra || {}),
    }
  }

  // ---------- 工具实现 ----------

  async function generate(args, exec) {
    if (!String(args.prompt || '').trim()) {
      return fail('EMPTY_PROMPT', 'prompt 不能为空：请先写清画面内容（主体+动作+镜头+光影+风格）。')
    }

    const params = normalizeParams(args, settings())
    let images = []
    try {
      for (const item of (Array.isArray(args.images) ? args.images : []).filter(Boolean)) {
        images.push(await resolveImage(item, exec))
      }
    } catch (error) {
      return fail('BAD_IMAGE', `图片处理失败：${error.message}`)
    }
    if (images.length > 4) {
      return fail('TOO_MANY_IMAGES', `最多 4 张参考图，现在给了 ${images.length} 张。`)
    }

    const hash = hashRequest(params, images)
    const duplicate = store.findByHash(hash)
    if (duplicate) return view(duplicate, { deduped: true })

    const waitSec = clampWaitSec(args.waitSec, settings().defaultWaitSec)

    if (args.dryRun === true) {
      return {
        ok: true,
        status: 'dry-run',
        taskId: null,
        model: params.model,
        params: {
          ratio: params.ratio, duration: params.duration,
          resolution: params.resolution, audio: params.audio, preset: params.preset,
        },
        elapsedSec: 0,
        videoPath: null,
        videoUrl: null,
        mediaUrl: null,
        error: null,
        deduped: false,
        estimate: { waitSec, images: images.length },
        message: [
          '（试算，未提交、未扣费）',
          `模型 ${params.model}`,
          `${params.duration}s / ${params.resolution} / ${params.ratio}${params.audio ? ' / 有声' : ''}`,
          `输出目录：${await outputRoot(exec)}`,
          ...params.warnings,
        ].join('\n'),
      }
    }

    if (!apiKey()) {
      return fail(
        'NO_API_KEY',
        `还没配置火山方舟 API Key。最省事：把 {"apiKey": "ark-..."} 填进\n${configFile}\n保存后直接再调一次即可（每次调用实时读取，不用重启）。\n也可以设置环境变量 ARK_API_KEY。Key 在火山方舟控制台「API Key 管理」创建，并确认已开通 Seedance 视频模型。`,
      )
    }

    if (store.countSince(startOfToday()) >= Number(settings().maxPerDay || 20)) {
      return fail('DAILY_LIMIT', `今天已提交 ${settings().maxPerDay} 条，达到每日上限。改配置 maxPerDay 或明天再来。`)
    }

    let created
    try {
      created = await createTask({
        baseUrl: baseUrl(),
        apiKey: apiKey(),
        body: buildBody({ ...params, images }),
        signal: exec && exec.signal,
      })
    } catch (error) {
      if (error instanceof ArkError) {
        return fail(error.code || 'ARK_ERROR', `提交失败：${error.message}`, {
          error: { code: error.code, message: error.message, retryable: error.retryable },
        })
      }
      throw error
    }

    const task = store.upsert({
      id: String(created.id || ''),
      status: 'queued',
      arkStatus: 'queued',
      createdAt: Date.now(),
      params: {
        ...params,
        name: params.name || args.name || params.prompt.slice(0, 24),
      },
      hash,
      prompt: params.prompt,
      images,
      videoUrl: null,
      videoPath: null,
      error: null,
    })

    if (!task || !task.id) return fail('BAD_RESPONSE', '创建任务成功但没拿到 task id，请到控制台确认。')

    if (waitSec > 0) return poll(task, waitSec, exec)
    return view(task)
  }

  async function check(args, exec) {
    const id = String(args.taskId || '').trim()
    if (!id) return fail('BAD_TASK_ID', '需要 taskId。可以从 seedance_generate 的返回或 seedance_list 里拿。')

    let task = store.get(id)
    if (!task) {
      if (!apiKey()) return fail('NO_API_KEY', '未配置 ARK_API_KEY，无法查询远端任务。')
      try {
        const remote = await getTask({ baseUrl: baseUrl(), apiKey: apiKey(), id, signal: exec && exec.signal })
        task = store.upsert({
          id,
          status: mapStatus(remote.status),
          arkStatus: remote.status,
          createdAt: (Number(remote.created_at) || Math.floor(Date.now() / 1000)) * 1000,
          params: {},
          videoUrl: extractVideoUrl(remote),
        })
      } catch (error) {
        return fail('TASK_NOT_FOUND', `查不到任务 ${id}：${error.message}`)
      }
    }
    if (!task) return fail('TASK_NOT_FOUND', `查不到任务 ${id}`)

    const waitSec = clampWaitSec(args.waitSec === undefined ? 30 : args.waitSec, 30)
    if (!LOCAL_DONE.has(task.status) && waitSec > 0) return poll(task, waitSec, exec)
    if (task.status === 'succeeded' && args.download !== false) task = await maybeDownload(task, exec)
    return view(task)
  }

  async function cancel(args, exec) {
    const id = String(args.taskId || '').trim()
    if (!id) return fail('BAD_TASK_ID', '需要 taskId。')
    const task = store.get(id)
    if (!task) return fail('TASK_NOT_FOUND', `本地没有任务 ${id}`)
    if (LOCAL_DONE.has(task.status)) {
      return view(task, { note: task.videoPath ? '任务已完成，文件已保存，无需取消。' : '任务已结束，无需取消。' })
    }
    if (!apiKey()) return fail('NO_API_KEY', '未配置 ARK_API_KEY，无法取消远端任务。')

    try {
      await cancelTask({ baseUrl: baseUrl(), apiKey: apiKey(), id, signal: exec && exec.signal })
    } catch (error) {
      return fail('CANCEL_FAILED', `取消失败：${error.message}`)
    }
    const next = store.patch(id, { status: 'cancelled', arkStatus: 'cancelled' }) || task
    return view(next)
  }

  async function list(args) {
    const items = store.list({ limit: args.limit, status: args.status })
    if (items.length === 0) {
      return {
        ok: true, status: 'empty', tasks: [], count: 0,
        message: '还没有生成过视频。',
      }
    }
    const lines = items.map((task, index) => {
      const params = task.params || {}
      const summary = `${index + 1}. ${task.status} · ${params.duration || '?'}s ${params.resolution || ''} · ${String(task.prompt || '').slice(0, 40)}`
      return `${summary}${task.videoPath ? `\n   ${task.videoPath}` : ''}`
    })
    return {
      ok: true,
      status: 'ok',
      tasks: items.map((task) => ({
        taskId: task.id,
        status: task.status,
        prompt: String(task.prompt || '').slice(0, 80),
        createdAt: task.createdAt,
        videoPath: task.videoPath || null,
      })),
      count: items.length,
      message: `最近 ${items.length} 条任务：\n${lines.join('\n')}`,
    }
  }

  // ---------- 注册 ----------

  ctx.tools.register(defineTool({
    name: 'seedance_generate',
    description: '用 Seedance 生成一段视频（文生视频 / 首帧图生视频 / 首尾帧 / 多图参考）。' +
      '提交后最多等 waitSec 秒，没完成就返回 running + taskId，之后用 seedance_check 继续查。' +
      '默认 standard 档（720p、5 秒、16:9）。high 档、≥1080p、>10 秒、批量生成前必须先问用户。' +
      '同样的请求 15 分钟内会命中幂等，不会重复扣费。',
    parameters: {
      prompt: { type: 'string', required: true, description: '画面描述：主体+动作+环境+镜头+光影+风格；>5 秒建议按时间轴分段' },
      images: { type: 'array', items: { type: 'string' }, description: '本地绝对路径或 https 图片；1 张=首帧，2 张=首尾帧，3–4 张=参考图（2.x）' },
      preset: { type: 'string', enum: PRESET_NAMES, description: 'draft=快而省，standard=默认，high=高清（贵）' },
      model: { type: 'string', description: '指定模型 ID（默认跟随 preset）；账号未开通 preset 模型时用它换，例如 doubao-seedance-2-5-260628' },
      ratio: { type: 'string', enum: RATIOS, description: '画面比例，默认 16:9' },
      duration: { type: 'number', description: '秒，4–15（受配置上限夹取），默认跟随 preset' },
      resolution: { type: 'string', enum: RESOLUTIONS, description: '默认跟随 preset；不能超过配置上限' },
      audio: { type: 'boolean', description: '是否生成声音（2.x 支持），默认 false' },
      watermark: { type: 'boolean', description: '是否加水印，默认 false' },
      name: { type: 'string', description: '文件名 slug，例如 rainy-street' },
      waitSec: { type: 'number', description: '本次最多等多少秒（0–240，默认 90）；0=提交后立刻返回' },
      dryRun: { type: 'boolean', description: '只试算参数，不提交不扣费' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    execute: generate,
  }))

  ctx.tools.register(defineTool({
    name: 'seedance_check',
    description: '查询 Seedance 任务状态，可等待并自动下载。任务完成会返回本地路径与播放链接。',
    parameters: {
      taskId: { type: 'string', required: true, description: 'seedance_generate 返回的 taskId' },
      waitSec: { type: 'number', description: '最多等待秒数（0–240，默认 30）' },
      download: { type: 'boolean', description: '成功后是否下载（默认 true）' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    execute: check,
  }))

  ctx.tools.register(defineTool({
    name: 'seedance_cancel',
    description: '取消一个还在排队/生成中的 Seedance 任务。已结束的任务不会被改动。',
    parameters: {
      taskId: { type: 'string', required: true, description: '要取消的 taskId' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    execute: cancel,
  }))

  ctx.tools.register(defineTool({
    name: 'seedance_list',
    description: '列出最近生成过的视频任务（本地记录），用于回答“生成过哪些”“刚才那个 taskId 是什么”。',
    parameters: {
      limit: { type: 'number', description: '返回条数，默认 10（1–100）' },
      status: { type: 'string', description: '按状态过滤：queued/running/succeeded/downloaded/failed/cancelled' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    execute: list,
  }))
}
