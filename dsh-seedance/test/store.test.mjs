import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { TaskStore } from '../lib/store.js'

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-seedance-store-'))
  const store = new TaskStore(join(dir, 'tasks.json'))
  return { store, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('upsert / get / list 基本行为', () => {
  const { store, cleanup } = tempStore()
  try {
    store.upsert({ id: 'a', status: 'queued', createdAt: 100, params: { duration: 5 } })
    store.upsert({ id: 'b', status: 'downloaded', createdAt: 200 })
    assert.equal(store.get('a').status, 'queued')
    assert.equal(store.list().length, 2)
    assert.equal(store.list()[0].id, 'b')
    assert.equal(store.list({ status: 'queued' }).length, 1)
    assert.equal(store.list({ limit: 1 }).length, 1)
  } finally { cleanup() }
})

test('patch 保留未提供的字段并刷新 updatedAt', () => {
  const { store, cleanup } = tempStore()
  try {
    store.upsert({ id: 'a', status: 'queued', createdAt: 100, params: { duration: 5 }, prompt: 'x' })
    const next = store.patch('a', { status: 'running' })
    assert.equal(next.status, 'running')
    assert.deepEqual(next.params, { duration: 5 })
    assert.equal(next.prompt, 'x')
    assert.ok(next.updatedAt >= 100)
  } finally { cleanup() }
})

test('持久化后重新加载能读回', () => {
  const { store, dir, cleanup } = tempStore()
  try {
    store.upsert({ id: 'a', status: 'downloaded', createdAt: 100, videoPath: 'C:/x.mp4' })
    const reloaded = new TaskStore(join(dir, 'tasks.json'))
    assert.equal(reloaded.get('a').videoPath, 'C:/x.mp4')
  } finally { cleanup() }
})

test('findByHash 跳过失败任务与超时任务', () => {
  const { store, cleanup } = tempStore()
  try {
    const now = 10_000_000
    store.upsert({ id: 'a', status: 'failed', hash: 'h', createdAt: now - 1000 })
    assert.equal(store.findByHash('h', 15 * 60 * 1000, now), null)

    store.upsert({ id: 'b', status: 'running', hash: 'h2', createdAt: now - 1000 })
    assert.equal(store.findByHash('h2', 15 * 60 * 1000, now).id, 'b')

    store.upsert({ id: 'c', status: 'running', hash: 'h3', createdAt: now - 60 * 60 * 1000 })
    assert.equal(store.findByHash('h3', 15 * 60 * 1000, now), null)
  } finally { cleanup() }
})

test('countSince 统计当日条数', () => {
  const { store, cleanup } = tempStore()
  try {
    const now = Date.now()
    store.upsert({ id: 'a', createdAt: now - 1000 })
    store.upsert({ id: 'b', createdAt: now - 2000 })
    store.upsert({ id: 'c', createdAt: now - 86400_000 * 2 })
    assert.equal(store.countSince(now - 86400_000), 2)
  } finally { cleanup() }
})
