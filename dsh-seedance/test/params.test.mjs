import test from 'node:test'
import assert from 'node:assert/strict'

import {
  normalizeParams, clampResolution, clampDuration, snapLegacyDuration,
  slugify, buildFileName, PRESETS,
} from '../lib/params.js'

test('normalizeParams 默认 standard 档', () => {
  const p = normalizeParams({ prompt: '海边日落' }, {})
  assert.equal(p.preset, 'standard')
  assert.equal(p.model, PRESETS.standard.model)
  assert.equal(p.resolution, '720p')
  assert.equal(p.duration, 5)
  assert.equal(p.ratio, '16:9')
  assert.equal(p.audio, false)
  assert.equal(p.watermark, false)
  assert.equal(p.seed, undefined)
})

test('normalizeParams 分辨率按时长上限夹取并给出警告', () => {
  const p = normalizeParams({ prompt: 'x', resolution: '4k', duration: 12 }, { maxResolution: '720p', maxDuration: 10 })
  assert.equal(p.resolution, '720p')
  assert.equal(p.duration, 10)
  assert.equal(p.warnings.length, 2)
})

test('分辨率排序与上限', () => {
  assert.equal(clampResolution('1080p', '720p'), '720p')
  assert.equal(clampResolution('480p', '1080p'), '480p')
  assert.equal(clampResolution('乱写', '1080p'), '720p')
  assert.equal(clampResolution('4k', undefined), '1080p')
})

test('时长夹取 4..15 且受配置上限约束', () => {
  assert.equal(clampDuration(1, 10), 4)
  assert.equal(clampDuration(99, 10), 10)
  assert.equal(clampDuration(99, 99), 15)
  assert.equal(clampDuration('x', 10), 5)
})

test('1.x 模型时长吸附到 5/10 且不支持音频', () => {
  const p = normalizeParams({ prompt: 'x', model: 'doubao-seedance-1-0-pro-250528', duration: 7, audio: true }, {})
  assert.equal(p.duration, 5)
  assert.equal(p.audio, false)
})

test('ratio 非法值回落到 16:9；枚举内保留', () => {
  assert.equal(normalizeParams({ prompt: 'x', ratio: '7:3' }, {}).ratio, '16:9')
  assert.equal(normalizeParams({ prompt: 'x', ratio: '9:16' }, {}).ratio, '9:16')
})

test('有图时默认 adaptive，显式比例优先', () => {
  assert.equal(normalizeParams({ prompt: 'x', images: ['a.png'] }, {}).ratio, 'adaptive')
  assert.equal(normalizeParams({ prompt: 'x', images: ['a.png'], ratio: '16:9' }, {}).ratio, '16:9')
})

test('slugify 处理非法字符与长度', () => {
  assert.equal(slugify('rainy street'), 'rainy-street')
  assert.equal(slugify('a/b:c*d?'), 'a-b-c-d')
  assert.equal(slugify('   '), 'video')
  assert.equal(slugify('中文标题 测试'), '中文标题-测试')
  assert.ok(slugify('x'.repeat(100)).length <= 40)
})

test('buildFileName 形如 2026-10-19-name-id.mp4', () => {
  const name = buildFileName(new Date(2026, 9, 19), 'rainy street', 'cgt-abc')
  assert.equal(name, '2026-10-19-rainy-street-cgt-abc.mp4')
})

test('snapLegacyDuration', () => {
  assert.equal(snapLegacyDuration(4), 5)
  assert.equal(snapLegacyDuration(7), 5)
  assert.equal(snapLegacyDuration(8), 10)
})
