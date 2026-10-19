/**
 * 参数归一化：preset → 模型/分辨率/时长，夹取到配置上限。
 * 纯函数，不依赖 DSH，方便单测。
 */

export const RESOLUTIONS = ['480p', '720p', '1080p', '4k']
export const RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive']
export const PRESET_NAMES = ['draft', 'standard', 'high']
export const MIN_DURATION = 4
export const MAX_DURATION = 15

export const PRESETS = {
  draft: { model: 'doubao-seedance-2-0-fast-260128', resolution: '480p', duration: 5 },
  standard: { model: 'doubao-seedance-2-0-260128', resolution: '720p', duration: 5 },
  high: { model: 'doubao-seedance-2-5-260628', resolution: '1080p', duration: 8 },
}

export function rankResolution(value) {
  return RESOLUTIONS.indexOf(String(value || ''))
}

/** 请求的分辨率不能超过配置上限；未知值按 720p。 */
export function clampResolution(requested, max) {
  const req = rankResolution(requested) >= 0 ? String(requested) : '720p'
  const capRank = rankResolution(max) >= 0 ? rankResolution(max) : rankResolution('1080p')
  return rankResolution(req) > capRank ? RESOLUTIONS[capRank] : req
}

/** 夹取到 [MIN_DURATION, min(MAX_DURATION, config.maxDuration)] */
export function clampDuration(requested, max) {
  const raw = Number(requested)
  const n = Number.isFinite(raw) ? Math.round(raw) : 5
  const configured = Number(max)
  const upper = Math.min(MAX_DURATION, Math.max(MIN_DURATION, Number.isFinite(configured) ? configured : 10))
  return Math.min(upper, Math.max(MIN_DURATION, n))
}

/** 1.x 只接受 5s / 10s 两档，就近吸附 */
export function snapLegacyDuration(duration) {
  return duration <= 7 ? 5 : 10
}

export function isLegacyModel(model) {
  return /seedance-1-0/i.test(String(model || ''))
}

/**
 * 把工具入参 + 插件配置归一成一份确定的生成参数。
 * @returns {{prompt:string, model:string, preset:string, ratio:string, duration:number,
 *            resolution:string, audio:boolean, watermark:boolean, seed:number|undefined,
 *            name:string, warnings:string[]}}
 */
export function normalizeParams(args = {}, config = {}) {
  const warnings = []

  const rawPrompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
  const prompt = rawPrompt.length > 0 ? rawPrompt : ''

  const presetName = PRESETS[args.preset]
    ? args.preset
    : (PRESETS[config.preset] ? config.preset : 'standard')
  const preset = PRESETS[presetName]

  const model = String(args.model || config.model || preset.model).trim()

  const requestedResolution = args.resolution || preset.resolution
  const resolution = clampResolution(requestedResolution, config.maxResolution)
  if (requestedResolution && resolution !== requestedResolution) {
    warnings.push(`分辨率已按上限降为 ${resolution}（请求 ${requestedResolution}）`)
  }

  let duration = clampDuration(args.duration == null ? preset.duration : args.duration, config.maxDuration)
  const requestedDuration = args.duration == null ? preset.duration : Number(args.duration)
  if (Number.isFinite(requestedDuration) && requestedDuration !== duration) {
    warnings.push(`时长已按上限调整为 ${duration}s（请求 ${requestedDuration}s）`)
  }
  if (isLegacyModel(model)) {
    const snapped = snapLegacyDuration(duration)
    if (snapped !== duration) warnings.push(`该模型只支持 5s/10s，时长已吸附为 ${snapped}s`)
    duration = snapped
  }

  // 有首帧图时默认跟随图片比例（adaptive），否则 16:9
  const hasImages = Array.isArray(args.images) && args.images.length > 0
  const ratio = RATIOS.includes(String(args.ratio))
    ? String(args.ratio)
    : (hasImages ? 'adaptive' : '16:9')

  const rawSeed = Number(args.seed)
  const seed = Number.isFinite(rawSeed) ? Math.trunc(rawSeed) : undefined

  return {
    prompt,
    model,
    preset: presetName,
    ratio,
    duration,
    resolution,
    audio: args.audio === true && !isLegacyModel(model),
    watermark: args.watermark === true,
    seed,
    name: typeof args.name === 'string' ? args.name : '',
    warnings,
  }
}

/** 文件名 slug：去掉 Windows 非法字符，保留中文，最长 40 字符。 */
export function slugify(input, fallback = 'video') {
  const raw = String(input || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 40)
  return raw || fallback
}

/** 本地任务文件名：2026-10-19-rainy-street-cgt-abc123.mp4 */
export function buildFileName(date, name, taskId) {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}-${slugify(name)}-${taskId}.mp4`
}
