/**
 * 视频下载：先写 .part 再原子重命名，失败不留半截文件。
 */

import { createWriteStream } from 'node:fs'
import { rename, unlink, mkdir } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { dirname } from 'node:path'

export async function downloadVideo(url, destPath, {
  signal,
  fetchImpl = fetch,
  maxBytes = 512 * 1024 * 1024,
  timeoutMs = 5 * 60 * 1000,
} = {}) {
  if (!url) throw new Error('缺少视频地址')

  const controller = new AbortController()
  const onAbort = () => controller.abort(signal.reason)
  if (signal) signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('下载超时')), timeoutMs)

  const tmp = `${destPath}.part`
  await mkdir(dirname(destPath), { recursive: true })

  try {
    const res = await fetchImpl(url, { signal: controller.signal })
    if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）`)

    const type = String(res.headers.get('content-type') || '')
    if (type && !/^(video\/|application\/octet-stream|binary\/octet-stream)/i.test(type)) {
      throw new Error(`响应不是视频（Content-Type: ${type}）`)
    }
    const length = Number(res.headers.get('content-length') || 0)
    if (length && length > maxBytes) {
      throw new Error(`视频过大（${(length / 1024 / 1024).toFixed(1)}MB）`)
    }
    if (!res.body) throw new Error('响应没有内容')

    await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp), { signal: controller.signal })
    await rename(tmp, destPath)
    return { path: destPath, bytes: length }
  } catch (error) {
    try { await unlink(tmp) } catch { /* 忽略清理失败 */ }
    if (signal && signal.aborted) throw signal.reason || error
    throw error
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}
