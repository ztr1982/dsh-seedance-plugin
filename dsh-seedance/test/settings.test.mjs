import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  readJsonFile, writeJsonFile, maskKey, effectiveSettings,
  usageSummary, seedanceModels, modelNotes,
} from '../lib/settings.js'

test('maskKey 只露头尾', () => {
  assert.equal(maskKey(''), '')
  assert.equal(maskKey('short'), '****')
  assert.equal(maskKey('ark-1234567890abcdef'), 'ark-…cdef')
})

test('effectiveSettings：文件优先于 patch，空值不覆盖', () => {
  const defaults = { apiKey: '', model: 'a', maxDuration: 10, autoDownload: true }
  const patch = { model: 'b', maxDuration: 12 }
  const file = { apiKey: 'ark-x', model: '', maxDuration: 8, autoDownload: false }
  const merged = effectiveSettings(defaults, patch, file)
  assert.equal(merged.apiKey, 'ark-x')
  assert.equal(merged.model, 'b', '空字符串不应覆盖 patch')
  assert.equal(merged.maxDuration, 8)
  assert.equal(merged.autoDownload, false)
})

test('readJsonFile 容忍 BOM 与坏文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-seedance-settings-'))
  try {
    const file = join(dir, 'c.json')
    writeFileSync(file, '\uFEFF{"apiKey":"ark-1"}')
    assert.equal(readJsonFile(file).apiKey, 'ark-1')
    writeFileSync(file, 'not json')
    assert.deepEqual(readJsonFile(file), {})
    assert.deepEqual(readJsonFile(join(dir, 'missing.json')), {})
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writeJsonFile 原子写且无 BOM', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-seedance-settings-'))
  try {
    const file = join(dir, 'sub', 'c.json')
    writeJsonFile(file, { apiKey: 'ark-1' })
    const bytes = readFileSync(file)
    assert.notEqual(bytes[0], 0xEF)
    assert.equal(JSON.parse(bytes.toString('utf8')).apiKey, 'ark-1')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('usageSummary 分今日/本月，累加秒数与 token', () => {
  const now = new Date(2026, 9, 19, 12, 0, 0).getTime()
  const tasks = [
    { createdAt: now - 1000, params: { duration: 5 }, usage: { total_tokens: 100 } },
    { createdAt: now - 86400_000, params: { duration: 4 }, usage: { total_tokens: 50 } },
    { createdAt: new Date(2026, 8, 1).getTime(), params: { duration: 8 }, usage: { total_tokens: 10 } },
  ]
  const { today, month } = usageSummary(tasks, now)
  assert.deepEqual(today, { count: 1, seconds: 5, tokens: 100 })
  assert.deepEqual(month, { count: 2, seconds: 9, tokens: 150 })
})

test('seedanceModels 过滤并排序', () => {
  const catalog = {
    data: [
      { id: 'doubao-seedance-2-0-260128', name: '2.0' },
      { id: 'doubao-pro-32k' },
      { id: 'doubao-seedance-1-0-pro-250528', name: '1.0' },
    ],
  }
  assert.deepEqual(seedanceModels(catalog).map((m) => m.id), [
    'doubao-seedance-1-0-pro-250528',
    'doubao-seedance-2-0-260128',
  ])
  assert.deepEqual(seedanceModels(null), [])
})

test('modelNotes 从历史推断可用性', () => {
  const notes = modelNotes([
    { params: { model: 'a' }, videoPath: 'x.mp4' },
    { params: { model: 'b' }, error: { code: 'MODEL_NOT_ACTIVATED' } },
    { params: { model: 'c' }, status: 'running' },
  ])
  assert.equal(notes.a, 'ok')
  assert.equal(notes.b, 'not_activated')
  assert.equal(notes.c, 'unknown')
})
