window.__ModuleLoader__.load({
  id: 'dsh-tacitweave',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const API = '/tacitweave/api'

    function TacitWeaveSettings({ api }) {
      const [state, setState] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [tab, setTab] = React.useState('long_term')
      const [threshold, setThreshold] = React.useState(0.65)

      const load = React.useCallback(async () => {
        try {
          const next = await api.read()
          setState(next)
          setThreshold(next.controls.activation_threshold)
          setError('')
        } catch (cause) {
          setError(String(cause.message || cause))
        }
      }, [api])

      React.useEffect(() => { void load() }, [load])

      const act = async (key, body) => {
        setBusy(key)
        try {
          const next = await api.write(body)
          setState(next)
          setThreshold(next.controls.activation_threshold)
          setError('')
        } catch (cause) {
          setError(String(cause.message || cause))
        } finally {
          setBusy('')
        }
      }

      if (state === null) return h('div', { className: 'tw-panel tw-loading' }, error || '正在读取本地记忆…')
      const controls = state.controls
      const memories = tab === 'long_term' ? state.long_term : state.temporary
      return h('div', { className: 'tw-panel' },
        h('header', { className: 'tw-header' },
          h('div', null,
            h('h2', null, 'TacitWeave'),
            h('p', null, '管理协作记忆的启用、触发与审核。所有内容只保存在本机。')),
          h('button', { className: 'tw-ghost', type: 'button', onClick: load, disabled: !!busy }, '刷新')),
        error && h('div', { className: 'tw-error', role: 'alert' }, error),
        h('section', { className: 'tw-card' },
          settingRow('启用 TacitWeave', '关闭后不向模型注入任何长期或临时记忆；已有文件保留。',
            checkbox(controls.enabled, value => act('enabled', { action: 'update_controls', patch: { enabled: value } }), busy === 'enabled')),
          settingRow('使用记忆前询问', '开启时在需要校准时先征求同意；关闭后由模型按相关性和阈值自行选择。',
            checkbox(controls.ask_before_activation, value => act('ask', { action: 'update_controls', patch: { ask_before_activation: value } }), busy === 'ask' || !controls.enabled)),
          settingRow('显示启用说明', '启用记忆时，在正式回答前用一句话说明所用经验及可信度。',
            checkbox(controls.announce_activation, value => act('announce', { action: 'update_controls', patch: { announce_activation: value } }), busy === 'announce' || !controls.enabled)),
          h('div', { className: 'tw-setting tw-threshold' },
            h('div', null,
              h('strong', null, '自动触发阈值'),
              h('p', null, '置信度低于阈值的记忆不会进入本轮候选；相关性仍由模型结合当前任务判断。')),
            h('div', { className: 'tw-slider' },
              h('input', {
                type: 'range', min: 0, max: 1, step: 0.05, value: threshold,
                disabled: !!busy || !controls.enabled,
                'aria-label': '自动触发阈值',
                onChange: event => setThreshold(Number(event.target.value)),
                onPointerUp: event => act('threshold', { action: 'update_controls', patch: { activation_threshold: Number(event.currentTarget.value) } }),
                onKeyUp: event => act('threshold', { action: 'update_controls', patch: { activation_threshold: Number(event.currentTarget.value) } }),
              }),
              h('output', null, threshold.toFixed(2))))),
        h('div', { className: 'tw-example' },
          controls.ask_before_activation
            ? '当前模式：模型选出相关记忆后，必要时先询问你是否按该协作方式继续。'
            : '自动模式示例：根据过往交流经验，本轮启用记忆：“用户在插件制作中倾向于计划后直接执行”（可信度：0.86）。'),
        h('nav', { className: 'tw-tabs', 'aria-label': '记忆类型' },
          tabButton('long_term', `长期记忆 ${state.long_term.length}`, tab, setTab),
          tabButton('temporary', `临时记忆 ${state.temporary.length}`, tab, setTab)),
        h('section', { className: 'tw-list' },
          memories.length === 0
            ? h('div', { className: 'tw-empty' }, tab === 'long_term' ? '还没有经过审核的长期记忆。' : '目前没有等待审核的临时记忆。')
            : memories.map(memory => memoryRow(memory, tab, busy, act))))
    }

    function settingRow(title, description, control) {
      return h('label', { className: 'tw-setting' },
        h('div', null, h('strong', null, title), h('p', null, description)), control)
    }

    function checkbox(checked, onChange, disabled) {
      return h('input', { type: 'checkbox', checked, disabled, onChange: event => onChange(event.target.checked) })
    }

    function tabButton(id, label, current, setTab) {
      return h('button', {
        type: 'button', className: current === id ? 'is-active' : '',
        'aria-selected': current === id, onClick: () => setTab(id),
      }, label)
    }

    function memoryRow(memory, kind, busy, act) {
      const key = `${kind}:${memory.id}`
      const confidence = Number(memory.confidence || 0)
      return h('article', { className: `tw-memory${memory.enabled ? '' : ' is-disabled'}`, key: memory.id },
        h('div', { className: 'tw-memory-head' },
          h('div', null,
            h('span', { className: 'tw-kind' }, kind === 'long_term' ? kindLabel(memory.kind) : '待审核'),
            memory.conflicts_with && memory.conflicts_with.length > 0 && h('span', { className: 'tw-conflict' }, '存在冲突')),
          checkbox(memory.enabled, value => act(key, { action: 'set_memory_enabled', kind, id: memory.id, enabled: value }), busy === key)),
        h('p', { className: 'tw-claim' }, memory.claim),
        h('div', { className: 'tw-meta' },
          h('span', null, `可信度 ${confidence.toFixed(2)}`),
          h('span', null, scopeLabel(memory.scope)),
          h('span', null, memory.id)),
        h('div', { className: 'tw-confidence', 'aria-label': `可信度 ${confidence.toFixed(2)}` },
          h('i', { style: { width: `${Math.round(confidence * 100)}%` } })),
        kind === 'temporary' && h('div', { className: 'tw-actions' },
          h('button', { type: 'button', disabled: !!busy, onClick: () => act(`accept:${memory.id}`, { action: 'review_temporary', id: memory.id, decision: 'accept' }) }, '接受为长期记忆'),
          h('button', { type: 'button', disabled: !!busy, onClick: () => act(`defer:${memory.id}`, { action: 'review_temporary', id: memory.id, decision: 'defer' }) }, '稍后审核'),
          h('button', { className: 'tw-danger', type: 'button', disabled: !!busy, onClick: () => act(`reject:${memory.id}`, { action: 'review_temporary', id: memory.id, decision: 'reject' }) }, '拒绝')))
    }

    function kindLabel(kind) {
      return kind === 'decision_boundary' ? '决策边界' : kind === 'temporary_context' ? '情境记忆' : '协作偏好'
    }

    function scopeLabel(scope) {
      const projects = scope && Array.isArray(scope.projects) ? scope.projects : []
      return projects.length ? `项目：${projects.join('、')}` : '跨项目'
    }

    const api = {
      async read() {
        const response = await fetch(API, { cache: 'no-store', credentials: 'same-origin' })
        const value = await response.json()
        if (!response.ok) throw new Error(value.error || `读取失败 (${response.status})`)
        return value
      },
      async write(body) {
        const response = await fetch(API, {
          method: 'POST', credentials: 'same-origin',
          headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        })
        const value = await response.json()
        if (!response.ok) throw new Error(value.error || `操作失败 (${response.status})`)
        return value.state
      },
    }

    const css = `
.tw-panel{padding:28px 30px 40px;color:var(--dsw-color-text,#1f2328);max-width:980px}.tw-header{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:22px}.tw-header h2{font-size:24px;margin:0 0 7px}.tw-header p,.tw-setting p{margin:0;color:var(--dsw-color-text-secondary,#6d7278);line-height:1.55}.tw-card{border:1px solid var(--dsw-color-border,#e1e4e8);border-radius:16px;background:var(--dsw-color-surface,#fff);overflow:hidden}.tw-setting{display:flex;align-items:center;justify-content:space-between;gap:28px;padding:18px 20px;border-bottom:1px solid var(--dsw-color-border,#eceef0)}.tw-setting:last-child{border-bottom:0}.tw-setting strong{display:block;margin-bottom:4px}.tw-setting input[type=checkbox]{width:20px;height:20px;flex:none}.tw-threshold{cursor:default}.tw-slider{display:flex;align-items:center;gap:12px;min-width:230px}.tw-slider input{width:180px}.tw-slider output{font-variant-numeric:tabular-nums;font-weight:700;min-width:36px}.tw-example{margin:14px 2px 22px;padding:12px 14px;border-radius:10px;background:var(--dsw-color-surface-subtle,#f5f7f9);color:var(--dsw-color-text-secondary,#5e646b);font-size:13px}.tw-tabs{display:flex;gap:24px;border-bottom:1px solid var(--dsw-color-border,#ddd);margin-bottom:15px}.tw-tabs button{border:0;background:none;padding:12px 2px;color:var(--dsw-color-text-secondary,#70757b);font-size:15px;cursor:pointer}.tw-tabs button.is-active{color:var(--dsw-color-text,#111);font-weight:700;border-bottom:2px solid currentColor}.tw-list{display:grid;gap:12px}.tw-memory{border:1px solid var(--dsw-color-border,#dfe3e7);border-radius:13px;padding:16px 17px;background:var(--dsw-color-surface,#fff);transition:opacity .15s}.tw-memory.is-disabled{opacity:.52}.tw-memory-head{display:flex;justify-content:space-between;gap:16px}.tw-kind,.tw-conflict{display:inline-block;font-size:12px;padding:3px 8px;border-radius:999px;background:var(--dsw-color-surface-subtle,#eef1f4);margin-right:7px}.tw-conflict{color:#b54708;background:#fff2e8}.tw-claim{font-size:15px;line-height:1.65;margin:11px 0}.tw-meta{display:flex;flex-wrap:wrap;gap:7px 16px;color:var(--dsw-color-text-secondary,#777);font-size:12px}.tw-confidence{height:4px;background:var(--dsw-color-surface-subtle,#e8ebee);border-radius:4px;margin-top:12px;overflow:hidden}.tw-confidence i{display:block;height:100%;background:#5b7cfa}.tw-actions{display:flex;gap:8px;margin-top:15px;flex-wrap:wrap}.tw-actions button,.tw-ghost{border:1px solid var(--dsw-color-border,#d8dce0);border-radius:8px;background:var(--dsw-color-surface,#fff);padding:7px 11px;cursor:pointer}.tw-actions button:first-child{background:#20242a;color:#fff;border-color:#20242a}.tw-actions .tw-danger{color:#b42318}.tw-actions button:disabled,.tw-ghost:disabled{opacity:.5;cursor:wait}.tw-empty,.tw-loading{padding:35px;text-align:center;color:var(--dsw-color-text-secondary,#777)}.tw-error{margin-bottom:12px;padding:10px 12px;border-radius:8px;background:#fff0ee;color:#b42318}
@media(max-width:720px){.tw-panel{padding:18px 16px}.tw-setting{align-items:flex-start;gap:14px}.tw-threshold{display:block}.tw-slider{margin-top:14px;min-width:0}.tw-slider input{width:100%}}
`

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.textContent = css
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'tacitweave: dashboard styles')
        ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
          name: 'settings.plugins.tab', id: 'tacitweave', order: 30,
          label: () => 'TacitWeave', inject: () => ({ api }),
        }, TacitWeaveSettings))
      },
    }
  },
})
