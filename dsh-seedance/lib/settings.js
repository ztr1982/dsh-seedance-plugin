/**
 * 面板用的配置与用量逻辑（纯函数，便于单测）。
 *
 * 配置优先级：默认值 < profile patch < ~/.dsh/dsh-seedance/config.json
 * —— 面板写的就是最后那个文件，所以面板里改完立刻生效（宿主按 mtime 重读）。
 */

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export function readJsonFile(file) {
  try {
    const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    const value = JSON.parse(text)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

export function writeJsonFile(file, value) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, file)
}

export function maskKey(key) {
  const text = String(key || '')
  if (!text) return ''
  if (text.length <= 10) return '****'
  return `${text.slice(0, 4)}…${text.slice(-4)}`
}

function isEmpty(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
}

/** 文件里显式写了的值优先；空字符串/ null 视为“没写” */
export function effectiveSettings(defaults, patch, file) {
  const merged = { ...defaults, ...(patch || {}) }
  for (const [key, value] of Object.entries(file || {})) {
    if (!isEmpty(value)) merged[key] = value
  }
  return merged
}

function startOfDay(now) {
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function startOfMonth(now) {
  const date = new Date(now)
  date.setDate(1)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function emptyBucket() {
  return { count: 0, seconds: 0, tokens: 0 }
}

function addTask(bucket, task) {
  bucket.count += 1
  const duration = Number(task && task.params && task.params.duration)
  if (Number.isFinite(duration)) bucket.seconds += duration
  const tokens = Number(task && task.usage && task.usage.total_tokens)
  if (Number.isFinite(tokens)) bucket.tokens += tokens
}

/** 用量统计：只统计真实数字（条数/秒数/token），不折算金额 */
export function usageSummary(tasks, now = Date.now()) {
  const dayStart = startOfDay(now)
  const monthStart = startOfMonth(now)
  const today = emptyBucket()
  const month = emptyBucket()
  for (const task of tasks || []) {
    const createdAt = Number(task && task.createdAt) || 0
    if (createdAt < monthStart) continue
    addTask(month, task)
    if (createdAt >= dayStart) addTask(today, task)
  }
  return { today, month }
}

/** 从 /models 目录里筛出 Seedance 视频模型 */
export function seedanceModels(catalog) {
  const list = Array.isArray(catalog && catalog.data) ? catalog.data : []
  return list
    .filter((model) => model && /seedance/i.test(String(model.id || '')))
    .map((model) => ({
      id: String(model.id),
      name: String(model.name || model.id),
      status: String(model.status || ''),
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

/** 从历史任务推断模型可用性（Ark 没有公开的“开通状态”接口） */
export function modelNotes(tasks) {
  const notes = {}
  for (const task of tasks || []) {
    const model = task && task.params && task.params.model
    if (!model) continue
    const code = task.error && task.error.code
    if (code === 'MODEL_NOT_ACTIVATED') notes[model] = 'not_activated'
    else if (task.videoPath) notes[model] = 'ok'
    else if (!notes[model]) notes[model] = 'unknown'
  }
  return notes
}
