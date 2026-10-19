/**
 * 本地任务表：JSON 持久化 + 幂等索引。
 * 纯 Node，不依赖 DSH。
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const VERSION = 1

export function emptyTask() {
  return {
    id: '',
    status: 'queued',
    arkStatus: 'queued',
    createdAt: 0,
    updatedAt: 0,
    params: {},
    hash: '',
    prompt: '',
    images: [],
    videoUrl: null,
    videoPath: null,
    error: null,
    downloadError: null,
  }
}

export class TaskStore {
  constructor(file, { max = 200 } = {}) {
    this.file = file
    this.max = max
    this.tasks = new Map()
    this.load()
  }

  load() {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8'))
      const list = Array.isArray(raw && raw.tasks) ? raw.tasks : []
      for (const task of list) {
        if (task && typeof task.id === 'string' && task.id) this.tasks.set(task.id, task)
      }
    } catch {
      // 文件不存在/损坏都从空表开始，不阻塞插件加载
    }
    return this
  }

  save() {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tasks = [...this.tasks.values()]
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
        .slice(-this.max)
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify({ version: VERSION, tasks }, null, 2), 'utf8')
      renameSync(tmp, this.file)
    } catch (error) {
      console.error('[dsh-seedance] 任务表写入失败:', error && error.message)
    }
  }

  get(id) {
    return this.tasks.get(String(id || '')) || null
  }

  upsert(task) {
    if (!task || !task.id) return null
    const now = Date.now()
    const prev = this.tasks.get(task.id)
    const next = {
      ...emptyTask(),
      ...(prev || {}),
      ...task,
      createdAt: (prev && prev.createdAt) || task.createdAt || now,
      updatedAt: now,
    }
    this.tasks.set(next.id, next)
    this.save()
    return next
  }

  patch(id, fields) {
    const prev = this.get(id)
    if (!prev) return null
    return this.upsert({ ...prev, ...fields })
  }

  list({ limit = 10, status } = {}) {
    let items = [...this.tasks.values()]
    if (status) items = items.filter((t) => t.status === status)
    items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    return items.slice(0, Math.max(1, Math.min(100, Number(limit) || 10)))
  }

  /** 15 分钟内同 hash 的、且没失败/取消的任务 → 复用，避免重复扣费。 */
  findByHash(hash, withinMs = 15 * 60 * 1000, now = Date.now()) {
    if (!hash) return null
    for (const task of this.tasks.values()) {
      if (task.hash !== hash) continue
      if (['failed', 'cancelled', 'expired'].includes(task.status)) continue
      if (now - (task.createdAt || 0) > withinMs) continue
      return task
    }
    return null
  }

  countSince(timestamp) {
    let count = 0
    for (const task of this.tasks.values()) {
      if ((task.createdAt || 0) >= timestamp) count += 1
    }
    return count
  }
}
