/**
 * dsh-seedance — 客户端半边：输入框旁的 🎬 按钮 + 浮层面板。
 *
 * 与 dsh-meme 相同的加载格式（window.__ModuleLoader__），数据全部走宿主的
 * /dsh-seedance/api/*（同源 HTTP，无需 RPC）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-seedance',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    const API = '/dsh-seedance/api'

    // ---------- 数据 ----------

    async function request(path, options) {
      const res = await fetch(API + path, options)
      let data = {}
      try { data = await res.json() } catch { /* 非 JSON 响应 */ }
      if (!res.ok || data.ok === false) {
        throw new Error((data && data.error) || `请求失败（HTTP ${res.status}）`)
      }
      return data
    }

    const apiGet = (path) => request(path, { headers: { accept: 'application/json' } })
    const apiPost = (path, body) => request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    })

    // ---------- 打开状态（两个 slot 共享）----------

    const ui = { open: false, listeners: new Set() }

    function setOpen(next) {
      ui.open = next
      for (const listener of ui.listeners) {
        try { listener(next) } catch { /* 单个订阅异常不影响其他订阅 */ }
      }
    }

    function useOpenState() {
      const [open, setLocal] = React.useState(ui.open)
      React.useEffect(() => {
        const listener = (value) => setLocal(value)
        ui.listeners.add(listener)
        setLocal(ui.open)
        return () => ui.listeners.delete(listener)
      }, [])
      return open
    }

    // ---------- 样式 ----------

    const CSS = [
      '.sd-mask{position:fixed;inset:0;background:rgba(0,0,0,.28);z-index:9998}',
      '.sd-panel{position:fixed;left:50%;bottom:92px;transform:translateX(-50%);width:min(780px,94vw);max-height:72vh;display:flex;flex-direction:column;z-index:9999;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#111);border:1px solid var(--dsw-alias-border-l1,#e6e6e6);border-radius:14px;box-shadow:0 18px 60px rgba(0,0,0,.28);overflow:hidden;font-size:13px}',
      '.sd-head{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1,#eee)}',
      '.sd-title{font-size:14px;font-weight:600}',
      '.sd-tabs{display:flex;gap:4px;margin-left:8px}',
      '.sd-tab{border:none;background:transparent;color:var(--dsw-alias-label-secondary,#666);padding:6px 10px;border-radius:8px;cursor:pointer;font-size:13px}',
      '.sd-tab.on{background:var(--dsw-alias-bg-layer-2,#f2f2f2);color:var(--dsw-alias-label-primary,#111);font-weight:600}',
      '.sd-spacer{flex:1}',
      '.sd-x{border:none;background:transparent;cursor:pointer;font-size:16px;color:var(--dsw-alias-label-secondary,#666);padding:4px 8px;border-radius:6px}',
      '.sd-x:hover{background:var(--dsw-alias-bg-layer-2,#f2f2f2)}',
      '.sd-body{padding:12px 14px;overflow:auto;flex:1}',
      '.sd-foot{display:flex;align-items:center;gap:8px;padding:9px 14px;border-top:1px solid var(--dsw-alias-border-l1,#eee);font-size:12px;color:var(--dsw-alias-label-secondary,#666)}',
      '.sd-trigger{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;border:none;border-radius:8px;background:transparent;cursor:pointer;font-size:16px;line-height:1}',
      '.sd-trigger:hover{background:var(--dsw-alias-bg-layer-2,#f2f2f2)}',
      '.sd-row{display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--dsw-alias-border-l1,#f0f0f0)}',
      '.sd-row:last-child{border-bottom:none}',
      '.sd-thumb{width:72px;height:41px;border-radius:6px;object-fit:cover;background:#000;flex:none}',
      '.sd-main{flex:1;min-width:0}',
      '.sd-prompt{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.sd-meta{font-size:11px;color:var(--dsw-alias-label-secondary,#777);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.sd-badge{font-size:11px;padding:2px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,#eee);flex:none}',
      '.sd-badge.ok{background:rgba(34,160,80,.14);color:#1a7f45}',
      '.sd-badge.bad{background:rgba(220,60,60,.14);color:#b32828}',
      '.sd-badge.busy{background:rgba(40,110,220,.14);color:#2359b0}',
      '.sd-btn{border:1px solid var(--dsw-alias-border-l1,#ddd);background:transparent;color:inherit;border-radius:8px;padding:4px 10px;cursor:pointer;font-size:12px;white-space:nowrap}',
      '.sd-btn:hover{background:var(--dsw-alias-bg-layer-2,#f2f2f2)}',
      '.sd-btn.primary{background:var(--dsw-alias-brand-primary,#2f6fed);border-color:transparent;color:#fff}',
      '.sd-btn.danger{color:#b32828;border-color:rgba(200,60,60,.4)}',
      '.sd-btn[disabled]{opacity:.5;cursor:default}',
      '.sd-field{display:flex;align-items:center;gap:10px;padding:7px 0}',
      '.sd-field label{width:118px;flex:none;color:var(--dsw-alias-label-secondary,#666);font-size:12px}',
      '.sd-field input,.sd-field select{flex:1;min-width:0;padding:6px 9px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,#ddd);background:var(--dsw-alias-bg-layer-2,#fafafa);color:inherit;font-size:12px;outline:none}',
      '.sd-note{font-size:12px;color:var(--dsw-alias-label-secondary,#666);margin:2px 0 8px;line-height:1.6}',
      '.sd-empty{padding:28px 0;text-align:center;color:var(--dsw-alias-label-secondary,#777);font-size:12px}',
      '.sd-chip{font-size:11px;padding:2px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2,#eee);flex:none}',
      '.sd-chip.ok{background:rgba(34,160,80,.14);color:#1a7f45}',
      '.sd-chip.no{background:rgba(220,60,60,.14);color:#b32828}',
      '.sd-notice{font-size:12px}',
      '.sd-error{font-size:12px;color:#b32828}',
    ].join('\n')

    function ensureStyle() {
      if (document.getElementById('dsh-seedance-style')) return
      const style = document.createElement('style')
      style.id = 'dsh-seedance-style'
      style.textContent = CSS
      document.head.appendChild(style)
    }

    // ---------- 小工具 ----------

    const STATUS = {
      downloaded: { label: '已保存', cls: 'ok' },
      succeeded: { label: '已生成', cls: 'ok' },
      running: { label: '生成中', cls: 'busy' },
      queued: { label: '排队中', cls: 'busy' },
      failed: { label: '失败', cls: 'bad' },
      cancelled: { label: '已取消', cls: 'bad' },
      expired: { label: '超时', cls: 'bad' },
    }

    function statusOf(status) {
      return STATUS[status] || { label: String(status || '未知'), cls: '' }
    }

    function timeAgo(timestamp) {
      const diff = Date.now() - Number(timestamp || 0)
      if (!diff || diff < 0) return ''
      const minutes = Math.floor(diff / 60000)
      if (minutes < 1) return '刚刚'
      if (minutes < 60) return `${minutes} 分钟前`
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return `${hours} 小时前`
      return `${Math.floor(hours / 24)} 天前`
    }

    const MODEL_NOTE = {
      ok: { label: '可用', cls: 'ok' },
      not_activated: { label: '未开通', cls: 'no' },
      unknown: { label: '未验证', cls: '' },
    }

    // ---------- 按钮 + 面板 ----------

    function SeedanceTrigger() {
      React.useEffect(() => { ensureStyle() }, [])
      const open = useOpenState()
      return h('button', {
        type: 'button',
        className: 'sd-trigger',
        title: 'Seedance 视频',
        'aria-label': 'Seedance 视频',
        onClick: () => setOpen(!ui.open),
      }, '🎬')
    }

    function SeedanceHost() {
      const open = useOpenState()
      if (!open) return null
      return h(SeedancePanel, { onClose: () => setOpen(false) })
    }

    function SeedancePanel({ onClose }) {
      const [tab, setTab] = React.useState('tasks')
      const [data, setData] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const [error, setError] = React.useState('')
      const [notice, setNotice] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [models, setModels] = React.useState([])
      const [notes, setNotes] = React.useState({})

      const load = React.useCallback(async (silent) => {
        try {
          const next = await apiGet('/state')
          setData(next)
          setModels(next.models || [])
          setNotes(next.modelNotes || {})
          setDraft((prev) => (prev && silent ? prev : { ...next.config }))
          setError('')
        } catch (err) {
          setError(err.message)
        }
      }, [])

      React.useEffect(() => { load(false) }, [load])

      React.useEffect(() => {
        if (tab !== 'tasks') return undefined
        const timer = setInterval(() => load(true), 5000)
        return () => clearInterval(timer)
      }, [tab, load])

      const config = (draft || (data && data.config) || {})

      function patchDraft(patch) {
        setDraft((prev) => ({ ...(prev || config), ...patch }))
        setNotice('')
      }

      async function save() {
        setBusy('save')
        setNotice('')
        try {
          const payload = {
            baseUrl: config.baseUrl,
            model: config.model,
            maxResolution: config.maxResolution,
            maxDuration: Number(config.maxDuration),
            maxPerDay: Number(config.maxPerDay),
            defaultWaitSec: Number(config.defaultWaitSec),
            outputDir: config.outputDir,
          }
          if (config.apiKey) payload.apiKey = config.apiKey
          if (config.clearKey) payload.clearKey = true
          const next = await apiPost('/config', payload)
          setData(next)
          setDraft({ ...next.config })
          setNotice('已保存，立即生效')
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy('')
        }
      }

      async function test() {
        setBusy('test')
        setNotice('')
        setError('')
        try {
          const result = await apiPost('/test')
          setModels(result.models || [])
          setNotes(result.notes || {})
          setNotice(`连接正常 · ${result.latencyMs}ms · 目录 ${result.totalModels} 个模型，Seedance ${(result.models || []).length} 个`)
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy('')
        }
      }

      async function refreshModels() {
        setBusy('models')
        setError('')
        try {
          const result = await apiPost('/models')
          setModels(result.models || [])
          setNotes(result.notes || {})
          setNotice(`已刷新，共 ${(result.models || []).length} 个 Seedance 模型`)
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy('')
        }
      }

      async function cancelTask(taskId) {
        setBusy('cancel:' + taskId)
        try {
          await apiPost('/cancel', { taskId })
          await load(true)
          setNotice('已取消')
        } catch (err) {
          setError(err.message)
        } finally {
          setBusy('')
        }
      }

      async function useModel(model) {
        patchDraft({ model })
        try {
          const next = await apiPost('/config', { model })
          setData(next)
          setDraft({ ...next.config })
          setNotice('默认模型已切换为 ' + model)
        } catch (err) {
          setError(err.message)
        }
      }

      const usage = (data && data.usage) || { today: {}, month: {} }

      return h(React.Fragment, null,
        h('div', { className: 'sd-mask', onClick: onClose }),
        h('div', { className: 'sd-panel', role: 'dialog', 'aria-label': 'Seedance 面板' },
          h('div', { className: 'sd-head' },
            h('span', { className: 'sd-title' }, '🎬 Seedance'),
            h('div', { className: 'sd-tabs' },
              tabButton('tasks', '任务', tab, setTab),
              tabButton('settings', '设置', tab, setTab),
              tabButton('models', '模型', tab, setTab)),
            h('span', { className: 'sd-spacer' }),
            h('button', { type: 'button', className: 'sd-x', onClick: onClose, title: '关闭' }, '✕')),

          h('div', { className: 'sd-body' },
            error ? h('div', { className: 'sd-error', style: { marginBottom: 8 } }, '⚠ ' + error) : null,
            data
              ? (tab === 'tasks'
                ? TasksTab({ data, usage, busy, cancelTask })
                : tab === 'settings'
                  ? SettingsTab({ config: { ...config, modelOptions: models.map((m) => m.id) }, patchDraft, save, busy })
                  : ModelsTab({ models, notes, busy, refreshModels, useModel, current: config.model }))
              : h('div', { className: 'sd-empty' }, '加载中…')),

          h('div', { className: 'sd-foot' },
            h('button', {
              type: 'button', className: 'sd-btn', disabled: busy === 'test', onClick: test,
            }, busy === 'test' ? '测试中…' : '测试连接'),
            h('span', null, data && data.config.hasKey ? `Key: ${data.config.apiKeyMasked}` : '未配置 Key'),
            h('span', { className: 'sd-spacer' }),
            notice ? h('span', { className: 'sd-notice' }, notice) : null)))
    }

    function tabButton(key, label, current, setTab) {
      return h('button', {
        type: 'button',
        className: 'sd-tab' + (current === key ? ' on' : ''),
        onClick: () => setTab(key),
      }, label)
    }

    function TasksTab({ data, usage, busy, cancelTask }) {
      const tasks = data.tasks || []
      const today = usage.today || {}
      const month = usage.month || {}
      return h(React.Fragment, null,
        h('div', { className: 'sd-note' },
          `今天 ${today.count || 0} 条 · ${today.seconds || 0}s · ${today.tokens || 0} tokens　|　` +
          `本月 ${month.count || 0} 条 · ${month.seconds || 0}s · ${month.tokens || 0} tokens`),
        tasks.length === 0
          ? h('div', { className: 'sd-empty' }, '还没有任务。在对话里说“用 Seedance 生成…”即可。')
          : h('div', null, tasks.map((task) => {
            const status = statusOf(task.status)
            const meta = [
              task.model,
              task.duration ? `${task.duration}s` : null,
              task.resolution,
              task.ratio,
              task.tokens ? `${task.tokens} tokens` : null,
              timeAgo(task.createdAt),
            ].filter(Boolean).join(' · ')
            return h('div', { className: 'sd-row', key: task.taskId },
              task.mediaUrl
                ? h('video', {
                  className: 'sd-thumb',
                  src: task.mediaUrl + '#t=0.1',
                  preload: 'metadata',
                  muted: true,
                  playsInline: true,
                })
                : h('div', { className: 'sd-thumb', style: { display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888' } }, '—'),
              h('div', { className: 'sd-main' },
                h('div', { className: 'sd-prompt', title: task.prompt }, task.prompt || '(无提示词)'),
                h('div', { className: 'sd-meta', title: meta }, meta),
                task.error ? h('div', { className: 'sd-meta', style: { color: '#b32828' } }, task.error.message) : null),
              h('span', { className: 'sd-badge ' + status.cls }, status.label),
              task.mediaUrl ? h('a', {
                className: 'sd-btn', href: task.mediaUrl, target: '_blank', rel: 'noreferrer noopener',
              }, '播放') : null,
              task.mediaUrl ? h('a', { className: 'sd-btn', href: task.mediaUrl, download: '' }, '下载') : null,
              (task.status === 'queued' || task.status === 'running')
                ? h('button', {
                  type: 'button',
                  className: 'sd-btn danger',
                  disabled: busy === 'cancel:' + task.taskId,
                  onClick: () => cancelTask(task.taskId),
                }, '取消')
                : null)
          })))
    }

    function field(label, node) {
      return h('div', { className: 'sd-field' }, h('label', null, label), node)
    }

    function SettingsTab({ config, patchDraft, save, busy }) {
      return h(React.Fragment, null,
        h('div', { className: 'sd-note' }, '设置保存在 ~/.dsh/dsh-seedance/config.json，保存后立即生效，不用重启。'),
        field('API Key',
          h('input', {
            type: 'password',
            value: config.apiKey || '',
            placeholder: config.hasKey ? `已保存 ${config.apiKeyMasked}（留空不改）` : 'ark-...',
            onChange: (event) => patchDraft({ apiKey: event.target.value, clearKey: false }),
            autoComplete: 'off',
          })),
        config.hasKey
          ? h('div', { style: { marginLeft: 128, marginBottom: 6 } },
            h('button', {
              type: 'button',
              className: 'sd-btn danger',
              onClick: () => patchDraft({ apiKey: '', clearKey: true }),
            }, '清除已保存的 Key'))
          : null,
        field('Base URL', h('input', {
          type: 'text', value: config.baseUrl || '',
          onChange: (event) => patchDraft({ baseUrl: event.target.value }),
        })),
        field('默认模型', h('input', {
          type: 'text', value: config.model || '', list: 'sd-model-list',
          placeholder: '例如 doubao-seedance-2-0-260128',
          onChange: (event) => patchDraft({ model: event.target.value }),
        })),
        h('datalist', { id: 'sd-model-list' },
          (config.modelOptions || []).map((id) => h('option', { key: id, value: id }))),
        field('分辨率上限', h('select', {
          value: config.maxResolution || '1080p',
          onChange: (event) => patchDraft({ maxResolution: event.target.value }),
        }, ['480p', '720p', '1080p', '4k'].map((value) => h('option', { key: value, value }, value)))),
        field('时长上限（秒）', h('input', {
          type: 'number', min: 4, max: 15, value: config.maxDuration ?? 10,
          onChange: (event) => patchDraft({ maxDuration: event.target.value }),
        })),
        field('每日条数上限', h('input', {
          type: 'number', min: 1, max: 200, value: config.maxPerDay ?? 20,
          onChange: (event) => patchDraft({ maxPerDay: event.target.value }),
        })),
        field('默认等待（秒）', h('input', {
          type: 'number', min: 0, max: 240, value: config.defaultWaitSec ?? 90,
          onChange: (event) => patchDraft({ defaultWaitSec: event.target.value }),
        })),
        field('输出目录', h('input', {
          type: 'text', value: config.outputDir || '',
          placeholder: 'outputs/seedance（相对工作区）',
          onChange: (event) => patchDraft({ outputDir: event.target.value }),
        })),
        h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 } },
          h('button', {
            type: 'button', className: 'sd-btn primary', disabled: busy === 'save', onClick: save,
          }, busy === 'save' ? '保存中…' : '保存')))
    }

    function ModelsTab({ models, notes, busy, refreshModels, useModel, current }) {
      return h(React.Fragment, null,
        h('div', { className: 'sd-note' },
          '模型来自火山方舟目录；「未开通」是根据历史报错推断的，开通后要跑一次才知道。',
          h('button', {
            type: 'button', className: 'sd-btn', style: { marginLeft: 8 }, disabled: busy === 'models', onClick: refreshModels,
          }, busy === 'models' ? '刷新中…' : '刷新')),
        models.length === 0
          ? h('div', { className: 'sd-empty' }, '还没有模型列表。点「测试连接」或「刷新」拉一次。')
          : h('div', null, models.map((model) => {
            const note = MODEL_NOTE[notes[model.id]] || MODEL_NOTE.unknown
            return h('div', { className: 'sd-row', key: model.id },
              h('div', { className: 'sd-main' },
                h('div', { className: 'sd-prompt' }, model.id),
                h('div', { className: 'sd-meta' }, [model.name, model.status].filter(Boolean).join(' · '))),
              h('span', { className: 'sd-chip ' + note.cls }, note.label),
              model.id === current
                ? h('span', { className: 'sd-chip ok' }, '当前默认')
                : h('button', {
                  type: 'button', className: 'sd-btn', onClick: () => useModel(model.id),
                }, '设为默认'))
          })))
    }

    // ---------- 注册 ----------

    function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return

      slots.inject('conversation.input.left', () => slots.register(
        { name: 'conversation.input.left', id: 'seedance', order: 6, label: 'Seedance' },
        () => React.createElement(SeedanceTrigger),
      ))

      slots.inject('conversation.input.overlay', () => slots.register(
        { name: 'conversation.input.overlay', id: 'seedance', order: 6, label: 'Seedance' },
        () => React.createElement(SeedanceHost),
      ))
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
