import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dsh-seedance-plugin-'))
process.env.DSH_HOME = home
delete process.env.ARK_API_KEY

const { prepareFixture, removeFixture } = await import('./fixture.mjs')
const { apply, name, inject } = await import(prepareFixture())

const originalFetch = globalThis.fetch

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function makeCtx() {
  const tools = new Map()
  const routes = []
  const handlers = {}
  const ctx = {
    tools: { register: (definition) => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
    webServer: { port: 63141, host: '127.0.0.1', register: (route) => { routes.push(route); return () => {} } },
    effect: (fn) => { const disposer = fn(); return disposer },
    on: (event, fn) => { handlers[event] = fn; return () => {} },
    get: () => undefined,
  }
  return { ctx, tools, routes, handlers }
}

test('插件加载：注册 4 个工具、媒体路由、系统提示', async () => {
  const { ctx, tools, routes, handlers } = makeCtx()
  apply(ctx, { apiKey: 'test-key' })

  assert.equal(name, 'dsh-seedance')
  assert.deepEqual(inject, ['tools', 'webServer', 'workingDirectory'])
  assert.deepEqual([...tools.keys()].sort(), ['seedance_cancel', 'seedance_check', 'seedance_generate', 'seedance_list'])
  assert.equal(routes.length, 2)
  assert.deepEqual(routes.map((route) => route.path).sort(), ['/dsh-seedance/api', '/dsh-seedance/media'])
  assert.equal(routes.every((route) => route.kind === 'prefix'), true)

  const assembled = { sections: [] }
  await handlers['system-prompt/assemble']({}, {}, async () => assembled)
  assert.equal(assembled.sections.at(-1).name, 'dsh-seedance')
  assert.match(assembled.sections.at(-1).text, /seedance_generate/)
})

test('完整链路：提交 → 轮询成功 → 下载 → 返回播放链接', async () => {
  const { ctx, tools } = makeCtx()
  apply(ctx, { apiKey: 'test-key', outputDir: join(home, 'out'), defaultWaitSec: 5, maxPerDay: 50 })

  const videoBytes = Buffer.from('fake-mp4')
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url)
    calls.push({ href, method: init.method || 'GET' })
    if (init.method === 'POST' && href.endsWith('/contents/generations/tasks')) {
      return json({ id: 'cgt-e2e-1' })
    }
    if (href.includes('/contents/generations/tasks/cgt-e2e-1')) {
      return json({ id: 'cgt-e2e-1', status: 'succeeded', content: { video_url: 'https://files.example/v.mp4' } })
    }
    if (href === 'https://files.example/v.mp4') {
      return new Response(videoBytes, {
        status: 200,
        headers: { 'content-type': 'video/mp4', 'content-length': String(videoBytes.length) },
      })
    }
    throw new Error(`未预期的请求：${href}`)
  }

  try {
    const generate = tools.get('seedance_generate')
    const result = await generate.execute({ prompt: '海边日落，镜头缓慢前推' }, {})

    assert.equal(result.ok, true, result.message)
    assert.equal(result.status, 'downloaded')
    assert.equal(result.taskId, 'cgt-e2e-1')
    assert.ok(result.videoPath && existsSync(result.videoPath), '视频应落盘')
    assert.match(result.mediaUrl, /^http:\/\/127\.0\.0\.1:63141\/dsh-seedance\/media\//)
    assert.match(result.message, /播放：/)

    const post = calls.filter((c) => c.method === 'POST')
    assert.equal(post.length, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('幂等：同参数第二次调用不重复提交', async () => {
  const { ctx, tools } = makeCtx()
  apply(ctx, { apiKey: 'test-key', outputDir: join(home, 'out'), defaultWaitSec: 0, maxPerDay: 50 })

  let posts = 0
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === 'POST') { posts += 1; return json({ id: 'cgt-e2e-2' }) }
    return json({ id: 'cgt-e2e-2', status: 'running' })
  }

  try {
    const generate = tools.get('seedance_generate')
    const first = await generate.execute({ prompt: '同一段话', waitSec: 0 }, {})
    const second = await generate.execute({ prompt: '同一段话', waitSec: 0 }, {})

    assert.equal(first.taskId, 'cgt-e2e-2')
    assert.equal(second.taskId, 'cgt-e2e-2')
    assert.equal(second.deduped, true)
    assert.equal(posts, 1, '不应重复提交')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('dryRun 不提交、不扣费', async () => {
  const { ctx, tools } = makeCtx()
  apply(ctx, { apiKey: 'test-key', outputDir: join(home, 'out') })

  let posts = 0
  globalThis.fetch = async () => { posts += 1; return json({}) }
  try {
    const result = await tools.get('seedance_generate').execute({ prompt: '试算一下', dryRun: true }, {})
    assert.equal(result.status, 'dry-run')
    assert.equal(posts, 0)
    assert.match(result.message, /未提交/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('没配 key 时返回可操作提示，而不是崩', async () => {
  const { ctx, tools } = makeCtx()
  apply(ctx, { apiKey: '' })
  const result = await tools.get('seedance_generate').execute({ prompt: 'x' }, {})
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'NO_API_KEY')
  assert.match(result.message, /ARK_API_KEY/)
})

test('任务失败时返回可读原因', async () => {
  const { ctx, tools } = makeCtx()
  apply(ctx, { apiKey: 'test-key', outputDir: join(home, 'out'), defaultWaitSec: 5, maxPerDay: 50 })

  globalThis.fetch = async (url, init = {}) => {
    const href = String(url)
    if (init.method === 'POST') return json({ id: 'cgt-e2e-3' })
    if (href.includes('/tasks/cgt-e2e-3')) {
      return json({ id: 'cgt-e2e-3', status: 'failed', error: { code: 'ContentRejected', message: '提示词不合规' } })
    }
    throw new Error(`未预期：${href}`)
  }

  try {
    const result = await tools.get('seedance_generate').execute({ prompt: '违规内容' }, {})
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'ContentRejected')
    assert.match(result.message, /生成失败/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('dryRun 不配 key 也能试算', async () => {
  const { ctx, tools } = makeCtx()
  apply(ctx, { apiKey: '' })
  const result = await tools.get('seedance_generate').execute({ prompt: 'x', dryRun: true }, {})
  assert.equal(result.status, 'dry-run', result.message)
})

test('从 dsh-seedance/config.json 读 key（免改 YAML、免重启）', async () => {
  mkdirSync(join(home, 'dsh-seedance'), { recursive: true })
  writeFileSync(join(home, 'dsh-seedance', 'config.json'), '\uFEFF' + JSON.stringify({ apiKey: 'ark-from-file' }))

  globalThis.fetch = async (url, init = {}) => {
    if (init.method === 'POST') return json({ id: 'cgt-file' })
    return json({ id: 'cgt-file', status: 'queued' })
  }

  try {
    const { ctx, tools } = makeCtx()
    apply(ctx, {})
    const result = await tools.get('seedance_generate').execute({ prompt: '用文件里的 key', waitSec: 0 }, {})
    assert.equal(result.ok, true, result.message)
    assert.equal(result.taskId, 'cgt-file')
    assert.notEqual(result.error && result.error.code, 'NO_API_KEY')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('已下载任务：check 不轮询、cancel 不调用远端、状态不被降级', async () => {
  const file = join(home, 'dsh-seedance', 'tasks.json')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({
    version: 1,
    tasks: [{
      id: 'cgt-done',
      status: 'downloaded',
      arkStatus: 'succeeded',
      createdAt: Date.now() - 5000,
      videoPath: join(home, 'out', 'x.mp4'),
      params: { duration: 4, resolution: '720p', ratio: '16:9' },
    }],
  }))

  let calls = 0
  globalThis.fetch = async () => { calls += 1; throw new Error('不该联网') }
  try {
    const { ctx, tools } = makeCtx()
    apply(ctx, { apiKey: 'k' })

    const cancelled = await tools.get('seedance_cancel').execute({ taskId: 'cgt-done' }, {})
    assert.equal(cancelled.status, 'downloaded')
    assert.match(cancelled.message, /无需取消/)
    assert.equal(calls, 0, '已完成任务不应调用远端取消')

    const checked = await tools.get('seedance_check').execute({ taskId: 'cgt-done', waitSec: 30 }, {})
    assert.equal(checked.status, 'downloaded')
    assert.match(checked.message, /播放：/)
    assert.equal(calls, 0, '已完成任务不应再轮询')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('cleanup', () => {
  rmSync(home, { recursive: true, force: true })
  removeFixture()
})
