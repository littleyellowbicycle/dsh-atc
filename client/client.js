/**
 * dsh-fleet-board — browser half.
 *
 * Adds a global main panel (a sidebar row like Plugins / Automations) that
 * lists every local agent session. The host already did all inference; this
 * half only renders and navigates.
 */

window.__ModuleLoader__.load({
  id: 'dsh-fleet-board',
  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useMemo, useState } = React
    const h = React.createElement

    const PANEL_ID = 'fleet-board'
    const ENDPOINT = '/dsh-fleet-board/data'
    const POLL_MS = 5000
    const ROW_CAP = 60

    /* ---------------------------------------------------------------- store */

    const store = { data: null, error: null, at: 0, listeners: new Set() }

    function publish(patch) {
      Object.assign(store, patch)
      for (const listener of store.listeners) listener()
    }

    let timer = null
    let inflight = false

    async function refresh() {
      if (inflight) return
      inflight = true
      try {
        const response = await fetch(ENDPOINT, { headers: { accept: 'application/json' } })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        publish({ data: await response.json(), error: null, at: Date.now() })
      } catch (error) {
        publish({ error: String(error && error.message ? error.message : error) })
      } finally {
        inflight = false
      }
    }

    function startPolling() {
      if (timer !== null) return () => {}
      refresh()
      timer = setInterval(refresh, POLL_MS)
      return () => {
        if (timer !== null) clearInterval(timer)
        timer = null
      }
    }

    function useBoard() {
      const [, force] = useState(0)
      useEffect(() => {
        const listener = () => force((value) => value + 1)
        store.listeners.add(listener)
        const stop = startPolling()
        return () => {
          store.listeners.delete(listener)
          if (store.listeners.size === 0) stop()
        }
      }, [])
      return store
    }

    /* ------------------------------------------------------------- vocabulary */

    const STATUS = {
      running: { label: '在跑', token: 'var(--dsw-alias-state-success-primary)' },
      'needs-you': { label: '等你', token: 'var(--dsw-alias-state-warn-primary)' },
      failed: { label: '失败', token: 'var(--dsw-alias-state-error-primary)' },
      stopped: { label: '已停', token: 'var(--dsw-alias-label-tertiary)' },
      done: { label: '完成', token: 'var(--dsw-alias-label-tertiary)' },
      recent: { label: '刚停', token: 'var(--dsw-alias-label-quaternary)' },
      idle: { label: '空闲', token: 'var(--dsw-alias-label-quaternary)' },
    }

    const TOOL_TOKEN = {
      dsh: 'var(--dsw-alias-brand-primary)',
      codex: 'var(--dsw-alias-state-success-primary)',
      opencode: 'var(--dsw-alias-state-warn-primary)',
      workbuddy: 'var(--dsw-alias-state-business-primary)',
    }

    function ago(ms) {
      if (!ms) return '—'
      const diff = Date.now() - ms
      if (diff < 0) return '刚刚'
      if (diff < 60_000) return `${Math.max(0, Math.round(diff / 1000))} 秒前`
      if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`
      if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`
      return `${Math.round(diff / 86_400_000)} 天前`
    }

    /**
     * Select a Session in the host UI. `uiWorkspace.openSession` is what the
     * shipped plugins call; `sessions.open` is kept as a fallback.
     */
    function openSession(ctx, sessionId) {
      if (!sessionId) return false
      try {
        const uiWorkspace = ctx.get?.('uiWorkspace') ?? ctx.uiWorkspace
        if (uiWorkspace && typeof uiWorkspace.openSession === 'function') {
          uiWorkspace.openSession(sessionId)
          return true
        }
        const sessions = ctx.get?.('sessions') ?? ctx.sessions
        if (sessions && typeof sessions.open === 'function') {
          sessions.open(sessionId)
          return true
        }
      } catch {
        /* navigation is best effort */
      }
      return false
    }

    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch {
        return false
      }
    }

    /* ------------------------------------------------------------- components */

    function PanelIcon({ size = 18 }) {
      const state = useBoard()
      const attention = state.data ? state.data.attention : 0
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('rect', { x: 3, y: 4, width: 18, height: 6, rx: 2 }),
        h('rect', { x: 3, y: 14, width: 11, height: 6, rx: 2 }),
        h('circle', { cx: 18.5, cy: 17, r: 2.5, fill: 'currentColor', stroke: 'none', opacity: 0.55 }),
        attention > 0
          ? h('circle', { cx: 20, cy: 5, r: 3.4, fill: 'var(--dsw-alias-state-warn-primary)', stroke: 'none' })
          : null,
      )
    }

    function Stat({ value, label, token }) {
      return h(
        'div',
        { className: 'fb-stat' },
        h('span', { className: 'fb-stat-value', style: token ? { color: token } : undefined }, value),
        h('span', { className: 'fb-stat-label' }, label),
      )
    }

    function Row({ item, onOpen }) {
      const status = STATUS[item.status] || STATUS.idle
      const clickable = Boolean(item.sessionId)
      return h(
        'div',
        {
          className: `fb-row${clickable ? ' fb-row-clickable' : ''}`,
          role: clickable ? 'button' : undefined,
          tabIndex: clickable ? 0 : undefined,
          title: clickable ? '打开这个会话' : `${item.workspace}（不支持跳转）`,
          onClick: () => onOpen(item),
          onKeyDown: (event) => {
            if (clickable && (event.key === 'Enter' || event.key === ' ')) {
              event.preventDefault()
              onOpen(item)
            }
          },
        },
        h(
          'div',
          { className: 'fb-row-main' },
          h(
            'div',
            { className: 'fb-row-title' },
            h('span', { className: 'fb-tool', style: { color: TOOL_TOKEN[item.tool] || 'inherit' } }, item.tool),
            h('span', { className: 'fb-title-text' }, item.title),
          ),
          h(
            'div',
            { className: 'fb-row-meta' },
            h('span', { className: 'fb-meta-text' }, item.workspace),
            item.detail ? h('span', { className: 'fb-dot' }, '·') : null,
            item.detail ? h('span', { className: 'fb-meta-text' }, item.detail) : null,
          ),
        ),
        h(
          'div',
          { className: 'fb-row-side' },
          h(
            'span',
            { className: 'fb-status', style: { color: status.token } },
            h('i', { className: 'fb-status-dot', style: { background: status.token } }),
            status.label,
          ),
          h('span', { className: 'fb-time' }, ago(item.lastActivity)),
        ),
      )
    }

    function Group({ title, items, token, defaultOpen, onOpen, hint }) {
      const [open, setOpen] = useState(defaultOpen)
      if (items.length === 0) return null
      const counts = {}
      for (const item of items) counts[item.tool] = (counts[item.tool] || 0) + 1
      const breakdown = Object.entries(counts)
        .map(([tool, count]) => `${tool} ${count}`)
        .join(' · ')
      const shown = open ? items.slice(0, ROW_CAP) : []
      return h(
        'section',
        { className: 'fb-group' },
        h(
          'button',
          { type: 'button', className: 'fb-group-head', onClick: () => setOpen((value) => !value) },
          h('span', { className: 'fb-caret' }, open ? '▾' : '▸'),
          h('span', { className: 'fb-group-title', style: token ? { color: token } : undefined }, title),
          h('span', { className: 'fb-count' }, String(items.length)),
          h('span', { className: 'fb-group-hint' }, hint || breakdown),
        ),
        shown.map((item) => h(Row, { key: `${item.tool}:${item.key}`, item, onOpen })),
        open && items.length > ROW_CAP
          ? h('div', { className: 'fb-cap' }, `只显示前 ${ROW_CAP} 条，共 ${items.length} 条`)
          : null,
      )
    }

    /** Split the flat payload into the bands a human actually triages. */
    function band(items) {
      const attention = []
      const running = []
      const recent = []
      const older = []
      const cutoff = Date.now() - 30 * 60_000
      for (const item of items) {
        if (item.status === 'needs-you' || item.status === 'failed') attention.push(item)
        else if (item.status === 'running') running.push(item)
        else if (item.lastActivity >= cutoff) recent.push(item)
        else older.push(item)
      }
      return { attention, running, recent, older }
    }

    function FleetPage(props) {
      const ctx = props.ctx
      const state = useBoard()
      const [notice, setNotice] = useState('')
      const board = state.data

      const flash = useCallback((text) => {
        setNotice(text)
        setTimeout(() => setNotice(''), 1800)
      }, [])

      const onOpen = useCallback(
        async (item) => {
          if (item.sessionId) {
            if (openSession(ctx, item.sessionId)) return
            flash('宿主没有提供会话跳转接口')
            return
          }
          const copied = await copyText(item.workspace)
          flash(copied ? `已复制工作区路径：${item.workspace}` : `工作区：${item.workspace}`)
        },
        [ctx, flash],
      )

      const bands = useMemo(() => (board ? band(board.items) : null), [board])

      return h(
        'div',
        { className: 'fb-page' },
        h('style', null, CSS),
        h(
          'header',
          { className: 'fb-head' },
          h(
            'div',
            null,
            h('h1', { className: 'fb-h1' }, '多 Agent 看板'),
            h(
              'p',
              { className: 'fb-sub' },
              '本机所有 agent 的会话 · 本地推断 · 零 token',
              notice ? h('span', { className: 'fb-notice' }, ` · ${notice}`) : null,
            ),
          ),
          h(
            'button',
            { type: 'button', className: 'fb-btn', onClick: () => refresh() },
            '刷新',
          ),
        ),

        state.error && !board
          ? h('div', { className: 'fb-error' }, `读取失败：${state.error}`)
          : null,

        !board
          ? h('div', { className: 'fb-empty' }, '正在扫描本机 agent…')
          : h(
              'div',
              { className: 'fb-body' },
              h(
                'div',
                { className: 'fb-stats' },
                h(Stat, { value: String(board.running), label: '在跑', token: STATUS.running.token }),
                h(Stat, { value: String(board.attention), label: '等你', token: STATUS['needs-you'].token }),
                h(Stat, { value: String(board.items.length), label: '显示' }),
              ),
              h(
                'div',
                { className: 'fb-sources' },
                (board.sources || []).map((source) =>
                  h(
                    'span',
                    {
                      key: source.tool,
                      className: `fb-chip${source.available ? '' : ' fb-chip-off'}`,
                      title: source.available
                        ? `${source.count || 0} 个会话`
                        : source.reason || '不可用',
                    },
                    source.tool,
                  ),
                ),
                h(
                  'span',
                  { className: 'fb-foot' },
                  board.total && board.total > board.items.length
                    ? `共 ${board.total} 个会话，只取最近 ${board.items.length} 个`
                    : `共 ${board.items.length} 个会话`,
                ),
              ),

              bands.attention.length === 0
                ? h('div', { className: 'fb-clear' }, '✓ 没有需要你处理的')
                : h(Group, {
                    title: '要你处理',
                    items: bands.attention,
                    token: STATUS['needs-you'].token,
                    defaultOpen: true,
                    onOpen,
                  }),
              h(Group, {
                title: '正在跑',
                items: bands.running,
                token: STATUS.running.token,
                defaultOpen: true,
                onOpen,
              }),
              h(Group, { title: '最近动过', items: bands.recent, defaultOpen: true, onOpen }),
              h(Group, {
                title: '更早',
                items: bands.older,
                defaultOpen: false,
                onOpen,
                hint: '点开查看',
              }),
            ),

        h(
          'footer',
          { className: 'fb-legend' },
          '点 DSH 行打开会话 · 点其它行复制工作区路径',
        ),
      )
    }

    /* ------------------------------------------------------------------ css */

    const CSS = `
.fb-page{box-sizing:border-box;max-width:880px;margin:0 auto;padding:20px 22px 28px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5}
.fb-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:14px}
.fb-h1{margin:0;font-size:16px;font-weight:600;letter-spacing:.01em}
.fb-sub{margin:3px 0 0;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.fb-notice{color:var(--dsw-alias-label-secondary)}
.fb-btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-button-elevated-fill);color:var(--dsw-alias-label-secondary);border-radius:7px;padding:4px 12px;font-size:12px;cursor:pointer;font-family:inherit}
.fb-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.fb-stats{display:flex;gap:22px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-card-fill);margin-bottom:10px}
.fb-stat{display:flex;flex-direction:column;gap:1px}
.fb-stat-value{font-size:18px;font-weight:650;font-variant-numeric:tabular-nums}
.fb-stat-label{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.fb-sources{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:0 0 6px}
.fb-chip{font-size:11px;padding:1px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary)}
.fb-chip-off{color:var(--dsw-alias-label-error);border-color:var(--dsw-alias-state-error-secondary)}
.fb-foot{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-quaternary)}
.fb-clear{padding:6px 2px 10px;font-size:12px;color:var(--dsw-alias-state-success-primary)}
.fb-group{margin-bottom:2px}
.fb-group-head{display:flex;align-items:center;gap:6px;width:100%;border:none;background:transparent;color:inherit;font-family:inherit;font-size:11.5px;font-weight:600;padding:8px 4px 5px;cursor:pointer;text-align:left}
.fb-caret{width:10px;color:var(--dsw-alias-label-quaternary);font-size:9px}
.fb-count{color:var(--dsw-alias-label-tertiary);font-weight:500}
.fb-group-hint{margin-left:auto;font-size:10.5px;font-weight:400;color:var(--dsw-alias-label-quaternary)}
.fb-row{display:flex;align-items:center;gap:12px;padding:7px 10px;border-radius:8px;border:1px solid transparent}
.fb-row-clickable{cursor:pointer}
.fb-row-clickable:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l1)}
.fb-row-main{min-width:0;flex:1}
.fb-row-title{display:flex;align-items:baseline;gap:8px;min-width:0}
.fb-tool{font-size:10.5px;font-weight:600;flex:none;text-transform:lowercase}
.fb-title-text{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}
.fb-row-meta{display:flex;align-items:baseline;gap:5px;min-width:0;margin-top:1px}
.fb-meta-text{font-size:11px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fb-dot{color:var(--dsw-alias-label-quaternary)}
.fb-row-side{display:flex;align-items:center;gap:10px;flex:none}
.fb-status{display:inline-flex;align-items:center;gap:5px;font-size:11px;white-space:nowrap}
.fb-status-dot{width:6px;height:6px;border-radius:50%;display:inline-block}
.fb-time{font-size:11px;color:var(--dsw-alias-label-quaternary);font-variant-numeric:tabular-nums;min-width:58px;text-align:right}
.fb-cap{padding:4px 12px;font-size:10.5px;color:var(--dsw-alias-label-quaternary)}
.fb-empty,.fb-error{padding:14px 2px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.fb-error{color:var(--dsw-alias-label-error)}
.fb-legend{margin-top:16px;padding-top:10px;border-top:1px solid var(--dsw-alias-separator-primary);font-size:10.5px;color:var(--dsw-alias-label-quaternary)}
`

    /* ---------------------------------------------------------------- wiring */

    const inject = []

    function apply(ctx) {
      // Wait for the slot registry inside a scoped inject: a host without it
      // must not keep `apply` from running, and a missing service must not throw.
      ctx.inject(['slots'], (inner) => {
        const slots = inner.slots
        if (!slots || typeof slots.register !== 'function') return
        const page = (props) => h(FleetPage, { ...props, ctx: inner })

        // The sidebar row (beside Plugins / Automations) …
        slots.inject('sidebar.panellist', () =>
          slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: 30,
              label: () => '看板',
            },
            PanelIcon,
          ),
        )
        // … and the main-column page it addresses.
        slots.inject('main', () =>
          slots.register({ name: 'main', key: PANEL_ID, registrant: PANEL_ID }, page),
        )

        globalThis.__dshFleetBoard = { registered: true, at: Date.now() }
      })
    }

    return {
      name: 'dsh-fleet-board',
      inject,
      apply,
      /** Seams for the offline render check; the host never reads these. */
      __test: { FleetPage, store, refresh },
    }
  },
})
