import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseRange, hostIsLoopback, createMediaHandler, DEFAULT_MEDIA_ROUTE } from '../lib/media.js'
import { TaskStore } from '../lib/store.js'
import { downloadVideo } from '../lib/download.js'

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-seedance-media-'))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('parseRange 全量/前缀/后缀/越界', () => {
  assert.equal(parseRange(undefined, 100), null)
  assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 })
  assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 })
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 })
  assert.deepEqual(parseRange('bytes=0-999', 100), { start: 0, end: 99 })
  assert.equal(parseRange('bytes=200-300', 100), 'invalid')
  assert.equal(parseRange('bytes=9-2', 100), 'invalid')
  assert.equal(parseRange('items=0-1', 100), null)
})

test('hostIsLoopback 只认回环', () => {
  assert.equal(hostIsLoopback({ headers: {} }), true)
  assert.equal(hostIsLoopback({ headers: { host: '127.0.0.1:63141' } }), true)
  assert.equal(hostIsLoopback({ headers: { host: 'localhost:1' } }), true)
  assert.equal(hostIsLoopback({ headers: { host: 'evil.com:63141' } }), false)
})

test('媒体路由 200 / 206 / 404', async () => {
  const { dir, cleanup } = tempDir()
  const video = join(dir, 'v.mp4')
  writeFileSync(video, Buffer.from('0123456789'))
  const store = new TaskStore(join(dir, 'tasks.json'))
  store.upsert({ id: 'cgt-1', status: 'downloaded', videoPath: video })
  const handler = createMediaHandler({ store })

  const server = createServer((req, res) => handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const base = `http://127.0.0.1:${port}${DEFAULT_MEDIA_ROUTE}`

  try {
    const full = await fetch(`${base}/cgt-1`)
    assert.equal(full.status, 200)
    assert.equal(full.headers.get('content-type'), 'video/mp4')
    assert.equal(await full.text(), '0123456789')

    const partial = await fetch(`${base}/cgt-1`, { headers: { Range: 'bytes=2-5' } })
    assert.equal(partial.status, 206)
    assert.equal(partial.headers.get('content-range'), 'bytes 2-5/10')
    assert.equal(await partial.text(), '2345')

    const missing = await fetch(`${base}/cgt-404`)
    assert.equal(missing.status, 404)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    cleanup()
  }
})

test('downloadVideo 落盘且失败清理 .part', async () => {
  const { dir, cleanup } = tempDir()
  const payload = Buffer.from('fake-mp4-bytes')
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': payload.length })
    res.end(payload)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const dest = join(dir, 'out', 'a.mp4')
    const result = await downloadVideo(`http://127.0.0.1:${port}/v.mp4`, dest)
    assert.equal(result.path, dest)
    assert.deepEqual(readFileSync(dest), payload)
    assert.equal(existsSync(`${dest}.part`), false)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    cleanup()
  }
})

test('downloadVideo 遇到非视频 content-type 报错且不留文件', async () => {
  const { dir, cleanup } = tempDir()
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<html>')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  try {
    const dest = join(dir, 'b.mp4')
    await assert.rejects(() => downloadVideo(`http://127.0.0.1:${port}/x`, dest), /不是视频/)
    assert.equal(existsSync(dest), false)
    assert.equal(existsSync(`${dest}.part`), false)
  } finally {
    await new Promise((resolve) => server.close(resolve))
    cleanup()
  }
})
