import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildBody, mapStatus, extractVideoUrl, extractError,
  createTask, getTask, ArkError, describeArkError,
} from '../lib/ark.js'

const base = {
  model: 'doubao-seedance-2-0-fast-260128',
  prompt: '赛博朋克雨夜',
  ratio: '16:9',
  duration: 5,
  resolution: '720p',
  audio: false,
  watermark: false,
  images: [],
}

test('2.x 请求体使用顶层字段', () => {
  const body = buildBody(base)
  assert.equal(body.model, base.model)
  assert.equal(body.content.length, 1)
  assert.equal(body.content[0].type, 'text')
  assert.equal(body.ratio, '16:9')
  assert.equal(body.duration, 5)
  assert.equal(body.resolution, '720p')
  assert.equal(body.generate_audio, false)
  assert.equal(body.watermark, false)
  assert.equal('seed' in body, false)
})

test('2.x 图片角色：1 张首帧 / 2 张首尾 / 3 张参考', () => {
  const one = buildBody({ ...base, images: ['https://a/1.png'] })
  assert.equal(one.content[1].role, 'first_frame')

  const two = buildBody({ ...base, images: ['https://a/1.png', 'https://a/2.png'] })
  assert.equal(two.content[1].role, 'first_frame')
  assert.equal(two.content[2].role, 'last_frame')

  const three = buildBody({ ...base, images: ['u1', 'u2', 'u3'] })
  assert.deepEqual(three.content.slice(1).map((c) => c.role), ['reference_image', 'reference_image', 'reference_image'])
})

test('1.x 请求体把参数写进文本后缀', () => {
  const body = buildBody({ ...base, model: 'doubao-seedance-1-0-pro-250528', images: ['u1'] })
  const text = body.content[0].text
  assert.match(text, /--resolution 720p/)
  assert.match(text, /--ratio 16:9/)
  assert.match(text, /--duration 5/)
  assert.match(text, /--watermark false/)
  assert.equal(body.content[1].type, 'image_url')
  assert.equal('ratio' in body, false)
})

test('seed 仅在有值时出现', () => {
  const body = buildBody({ ...base, seed: 42 })
  assert.equal(body.seed, 42)
})

test('状态映射与别名', () => {
  assert.equal(mapStatus('queued'), 'queued')
  assert.equal(mapStatus('processing'), 'running')
  assert.equal(mapStatus('success'), 'succeeded')
  assert.equal(mapStatus('canceled'), 'cancelled')
  assert.equal(mapStatus('whatever'), 'running')
  assert.equal(mapStatus(''), 'queued')
})

test('提取视频地址与错误', () => {
  assert.equal(extractVideoUrl({ content: { video_url: 'u' } }), 'u')
  assert.equal(extractVideoUrl({ content: { video: { url: 'v' } } }), 'v')
  assert.equal(extractVideoUrl({}), null)
  assert.deepEqual(extractError({ error: { code: 'X', message: 'm' } }), { code: 'X', message: 'm' })
  assert.equal(extractError({}), null)
})

test('createTask 发送 Bearer 与 JSON body', async () => {
  let captured
  const fetchImpl = async (url, init) => {
    captured = { url, init }
    return new Response(JSON.stringify({ id: 'cgt-1' }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const data = await createTask({ baseUrl: 'https://ark.example/api/v3/', apiKey: 'k', body: { model: 'm' }, fetchImpl })
  assert.equal(data.id, 'cgt-1')
  assert.equal(captured.url, 'https://ark.example/api/v3/contents/generations/tasks')
  assert.equal(captured.init.method, 'POST')
  assert.equal(captured.init.headers.Authorization, 'Bearer k')
  assert.deepEqual(JSON.parse(captured.init.body), { model: 'm' })
})

test('4xx 归一化成 ArkError 且不可重试', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ error: { code: 'BadRequest', message: '参数错' } }), { status: 400 })
  await assert.rejects(
    () => createTask({ baseUrl: 'https://x/api/v3', apiKey: 'k', body: {}, fetchImpl }),
    (error) => {
      assert.ok(error instanceof ArkError)
      assert.equal(error.code, 'BadRequest')
      assert.equal(error.retryable, false)
      return true
    },
  )
})

test('describeArkError 把英文报错翻译成可操作提示', () => {
  const a = describeArkError('Your account 1234567890 has not activated the model doubao-seedance-2-0-fast-260128. Please activate the model service in the Ark Console.')
  assert.equal(a.code, 'MODEL_NOT_ACTIVATED')
  assert.match(a.message, /开通管理/)
  assert.match(a.message, /doubao-seedance-2-0-fast-260128/)
  assert.doesNotMatch(a.message, /模型 。/)

  const b = describeArkError('The model or endpoint foo does not exist or you do not have access to it.')
  assert.equal(b.code, 'MODEL_NOT_FOUND')

  const c = describeArkError('Invalid API key provided')
  assert.equal(c.code, 'AUTH_FAILED')

  assert.equal(describeArkError('boom').code, '')
  assert.equal(describeArkError('boom').message, 'boom')
})

test('429 可重试，getTask 会退避重试后成功', async () => {
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    if (calls === 1) return new Response(JSON.stringify({ error: { code: 'RateLimit', message: '慢点' } }), { status: 429 })
    return new Response(JSON.stringify({ id: 'cgt-1', status: 'running' }), { status: 200 })
  }
  const task = await getTask({ baseUrl: 'https://x/api/v3', apiKey: 'k', id: 'cgt-1', fetchImpl })
  assert.equal(task.status, 'running')
  assert.equal(calls, 2)
})
