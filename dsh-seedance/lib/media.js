/**
 * 媒体路由：把已生成的 mp4 以 HTTP 暴露给 GUI（仅本机回环，支持 Range）。
 */

import { createReadStream, statSync } from 'node:fs'

export const DEFAULT_MEDIA_ROUTE = '/dsh-seedance/media'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])

export function hostIsLoopback(req) {
  const raw = String((req && req.headers && req.headers.host) || '')
  if (!raw) return true
  const name = raw.startsWith('[') ? raw.slice(0, raw.indexOf(']') + 1) : raw.split(':')[0]
  return LOOPBACK_HOSTS.has(name.toLowerCase())
}

/**
 * 解析 Range。
 * @returns {null} 无 Range 或无法识别（按 200 全量返回）
 * @returns {'invalid'} 区间非法（应回 416）
 * @returns {{start:number,end:number}} 合法闭区间
 */
export function parseRange(header, size) {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim())
  if (!match) return null
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return null

  let start
  let end
  if (rawStart === '') {
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Number(rawEnd)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'invalid'
  if (start > end || start >= size || start < 0) return 'invalid'
  if (end >= size) end = size - 1
  return { start, end }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

export function createMediaHandler({ store, route = DEFAULT_MEDIA_ROUTE }) {
  const prefix = route.replace(/\/+$/, '') + '/'

  return function mediaHandler(req, res) {
    if (!hostIsLoopback(req)) {
      sendJson(res, 403, { ok: false, error: '只接受本机请求' })
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }

    const pathname = String(req.url || '').split('?')[0]
    if (!pathname.startsWith(prefix)) {
      sendJson(res, 404, { ok: false, error: 'not found' })
      return
    }

    let id
    try {
      id = decodeURIComponent(pathname.slice(prefix.length)).replace(/\/+$/, '')
    } catch {
      sendJson(res, 400, { ok: false, error: 'bad id' })
      return
    }

    const task = id ? store.get(id) : null
    const file = task && task.videoPath
    if (!file) {
      sendJson(res, 404, { ok: false, error: '视频不存在或尚未生成' })
      return
    }

    let stat
    try {
      stat = statSync(file)
    } catch {
      sendJson(res, 404, { ok: false, error: '文件已被移动或删除' })
      return
    }
    if (!stat.isFile()) {
      sendJson(res, 404, { ok: false, error: 'not a file' })
      return
    }

    const range = parseRange(req.headers.range, stat.size)
    if (range === 'invalid') {
      res.writeHead(416, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Range': `bytes */${stat.size}`,
      })
      res.end(JSON.stringify({ ok: false, error: 'range not satisfiable' }))
      return
    }

    const headers = {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
      'Content-Disposition': `inline; filename="${encodeURIComponent(id)}.mp4"`,
    }

    if (range) {
      headers['Content-Range'] = `bytes ${range.start}-${range.end}/${stat.size}`
      headers['Content-Length'] = range.end - range.start + 1
      res.writeHead(206, headers)
      if (req.method === 'HEAD') { res.end(); return }
      createReadStream(file, { start: range.start, end: range.end }).pipe(res)
      return
    }

    headers['Content-Length'] = stat.size
    res.writeHead(200, headers)
    if (req.method === 'HEAD') { res.end(); return }
    createReadStream(file).pipe(res)
  }
}
