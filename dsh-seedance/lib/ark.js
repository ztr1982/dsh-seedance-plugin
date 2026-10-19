/**
 * 火山方舟 Seedance 视频生成客户端。
 * 只依赖全局 fetch，方便注入假实现做集成测试。
 */

import { isLegacyModel } from './params.js'

export class ArkError extends Error {
  constructor(message, { code = 'ARK_ERROR', status = 0, retryable = false, detail } = {}) {
    super(message)
    this.name = 'ArkError'
    this.code = code
    this.status = status
    this.retryable = retryable
    this.detail = detail
  }
}

export const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'expired'])

const STATUS_ALIASES = {
  queued: 'queued',
  pending: 'queued',
  created: 'queued',
  submitted: 'queued',
  running: 'running',
  processing: 'running',
  in_progress: 'running',
  succeeded: 'succeeded',
  success: 'succeeded',
  done: 'succeeded',
  completed: 'succeeded',
  failed: 'failed',
  error: 'failed',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  deleted: 'cancelled',
  expired: 'expired',
}

export function mapStatus(raw) {
  const key = String(raw || '').toLowerCase()
  return STATUS_ALIASES[key] || (key ? 'running' : 'queued')
}

export function extractVideoUrl(task) {
  const content = task && task.content
  if (!content) return null
  if (typeof content.video_url === 'string' && content.video_url) return content.video_url
  if (content.video && typeof content.video.url === 'string') return content.video.url
  return null
}

export function extractError(task) {
  const err = (task && (task.error || (task.content && task.content.error))) || null
  if (!err) return null
  return {
    code: String(err.code || err.type || 'GENERATION_FAILED'),
    message: String(err.message || '视频生成失败'),
  }
}

/**
 * 把 Ark 的英文报错翻译成可操作的中文提示。
 * 保留原始信息，方便排查。
 */
export function describeArkError(message) {
  const text = String(message || '')
  const notActivated = /has not activated the model/i.test(text)
  if (notActivated) {
    const id = (/model\s+([A-Za-z0-9][\w-]*)/i.exec(text) || [])[1] || ''
    return {
      code: 'MODEL_NOT_ACTIVATED',
      message: `当前账号还没开通模型 ${id}。到火山方舟控制台「开通管理」里开通 Seedance（视频生成），刚开通一般 1–5 分钟生效。原始信息：${text}`,
    }
  }
  if (/does not exist or you do not have access/i.test(text)) {
    return {
      code: 'MODEL_NOT_FOUND',
      message: `模型不存在或当前账号无权访问：核对模型 ID，确认已在控制台开通；若你的账号用推理接入点，就把 ep-... 当作 model 传入。原始信息：${text}`,
    }
  }
  if (/invalid.*api.*key|authentication|unauthorized|身份认证/i.test(text)) {
    return {
      code: 'AUTH_FAILED',
      message: `API Key 无效或已失效，去火山方舟控制台重新复制一个。原始信息：${text}`,
    }
  }
  if (/quota|insufficient|balance|欠费|余额/i.test(text)) {
    return {
      code: 'QUOTA_EXCEEDED',
      message: `额度不足或账号欠费，去控制台充值/查看配额。原始信息：${text}`,
    }
  }
  return { code: '', message: text }
}

/**
 * 组请求体。1.x 把参数写在文本后缀里，2.x 用顶层字段——不能一套打天下。
 * p.images 是已经解析好的 URL / data URL 列表。
 */
export function buildBody(p) {
  const legacy = isLegacyModel(p.model)
  if (legacy) {
    const flags = [
      `--resolution ${p.resolution}`,
      `--ratio ${p.ratio}`,
      `--duration ${p.duration}`,
      `--watermark ${p.watermark ? 'true' : 'false'}`,
    ].join(' ')
    const content = [{ type: 'text', text: `${p.prompt} ${flags}`.trim() }]
    for (const url of p.images || []) {
      content.push({ type: 'image_url', image_url: { url } })
    }
    return { model: p.model, content }
  }

  const content = [{ type: 'text', text: p.prompt }]
  const images = p.images || []
  images.forEach((url, index) => {
    let role
    if (images.length === 1) role = 'first_frame'
    else if (images.length === 2) role = index === 0 ? 'first_frame' : 'last_frame'
    else role = 'reference_image'
    content.push({ type: 'image_url', image_url: { url }, role })
  })

  const body = {
    model: p.model,
    content,
    ratio: p.ratio,
    duration: p.duration,
    resolution: p.resolution,
    generate_audio: p.audio === true,
    watermark: p.watermark === true,
  }
  if (p.seed !== undefined) body.seed = p.seed
  return body
}

function joinUrl(baseUrl, path) {
  return String(baseUrl).replace(/\/+$/, '') + path
}

async function request(url, { method = 'GET', apiKey, body, fetchImpl = fetch, signal, timeoutMs = 60000 } = {}) {
  if (signal && signal.aborted) throw signal.reason || new ArkError('已取消', { code: 'ABORTED' })

  const controller = new AbortController()
  const onAbort = () => controller.abort(signal.reason)
  if (signal) signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('请求超时')), timeoutMs)

  try {
    const res = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await res.text()
    let data = null
    try { data = text ? JSON.parse(text) : null } catch { data = { raw: text } }

    if (!res.ok) {
      const err = (data && data.error) || {}
      const mapped = describeArkError(err.message || `火山方舟请求失败（HTTP ${res.status}）`)
      throw new ArkError(mapped.message, {
        code: mapped.code || err.code || `HTTP_${res.status}`,
        status: res.status,
        retryable: res.status === 429 || res.status >= 500,
        detail: data,
      })
    }
    return data
  } catch (error) {
    if (error instanceof ArkError) throw error
    if (signal && signal.aborted) throw signal.reason || new ArkError('已取消', { code: 'ABORTED' })
    if (error && (error.name === 'AbortError' || /timeout|超时/i.test(String(error.message)))) {
      throw new ArkError('请求超时', { code: 'TIMEOUT', retryable: true })
    }
    throw new ArkError(`网络错误：${error && error.message ? error.message : String(error)}`, { code: 'NETWORK', retryable: true })
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

async function withRetry(fn, { attempts = 3, baseDelayMs = 2000, signal } = {}) {
  let lastError
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (!(error instanceof ArkError) || !error.retryable || i === attempts - 1) throw error
      await sleep(baseDelayMs * 2 ** i, signal)
    }
  }
  throw lastError
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(signal.reason || new ArkError('已取消', { code: 'ABORTED' }))
      return
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason || new ArkError('已取消', { code: 'ABORTED' }))
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** 创建任务：失败不自动重试（避免重复扣费），只有 429 由调用方决定是否重试。 */
export async function createTask({ baseUrl, apiKey, body, fetchImpl, signal }) {
  return request(joinUrl(baseUrl, '/contents/generations/tasks'), {
    method: 'POST', apiKey, body, fetchImpl, signal, timeoutMs: 60000,
  })
}

export async function getTask({ baseUrl, apiKey, id, fetchImpl, signal, retries = 3 }) {
  return withRetry(
    () => request(joinUrl(baseUrl, `/contents/generations/tasks/${encodeURIComponent(id)}`), {
      apiKey, fetchImpl, signal, timeoutMs: 30000,
    }),
    { attempts: retries, signal },
  )
}

export async function cancelTask({ baseUrl, apiKey, id, fetchImpl, signal }) {
  return withRetry(
    () => request(joinUrl(baseUrl, `/contents/generations/tasks/${encodeURIComponent(id)}`), {
      method: 'DELETE', apiKey, fetchImpl, signal, timeoutMs: 30000,
    }),
    { attempts: 2, signal },
  )
}
