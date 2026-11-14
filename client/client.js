/**
 * dsh-fleet-board — browser half.
 *
 * Registers one right-Sidebar tab type and its body. The body polls the host's
 * `/dsh-fleet-board/data` route; every pixel of inference already happened on
 * the host, so this half only renders.
 */

window.__ModuleLoader__.load({
  id: 'dsh-fleet-board',
  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useMemo, useState } = React
    const h = React.createElement

    const KIND = 'fleet-board'
    const TAB_ID = 'dsh-fleet-board'
    const ENDPOINT = '/dsh-fleet-board/data'
    const POLL_MS = 5000

    /** One module-level store keeps the body and the tab title on the same poll. */
    const store = {
      data: null,
      error: null,
      at: 0,
      listeners: new Set(),
    }

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
        const listener = () => force((n) => n + 1)
        store.listeners.add(listener)
        const stop = startPolling()
        return () => {
          store.listeners.delete(listener)
          if (store.listeners.size === 0) stop()
        }
      }, [])
      return store
    }

    const STATUS = {
      running: { label: '在跑', color: '#2f9e6f', dot: '●' },
      'needs-you': { label: '等你', color: '#d98324', dot: '▲' },
      failed: { label: '失败', color: '#c0392b', dot: '✗' },
      stopped: { label: '已停', color: '#8a94a6', dot: '■' },
      done: { label: '完成', color: '#7a8699', dot: '✓' },
      recent: { label: '刚停', color: '#8a94a6', dot: '·' },
      idle: { label: '空闲', color: '#9aa3b2', dot: ' ' },
    }

    const TOOL_COLOR = {
      dsh: '#4c6ef5',
      codex: '#12b886',
      opencode: '#f08c00',
      workbuddy: '#7048e8',
      trae: '#e8590c',
      minimax: '#c2255c',
    }

    function ago(ms) {
      if (!ms) return '—'
      const diff = Date.now() - ms
      if (diff < 0) return '刚刚'
      if (diff < 60000) return `${Math.max(0, Math.round(diff / 1000))} 秒前`
      if (diff < 3600000) return `${Math.round(diff / 60000)} 分钟前`
      if (diff < 86400000) return `${Math.round(diff / 3600000)} 小时前`
      return `${Math.round(diff / 86400000)} 天前`
    }

    function Chip({ item }) {
      const status = STATUS[item.status] || STATUS.idle
      return h(
        'span',
        { style: { color: status.color, whiteSpace: 'nowrap' } },
        `${status.dot} ${status.label}`,
      )
    }

    function Row({ item }) {
      const [hover, setHover] = useState(false)
      const toolColor = TOOL_COLOR[item.tool] || '#6b7280'
      return h(
        'div',
        {
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            display: 'grid',
            gridTemplateColumns: '68px 62px 74px 1fr',
            gap: '6px',
            alignItems: 'baseline',
            padding: '6px 8px',
            borderRadius: '5px',
            background: hover ? 'rgba(127,127,127,0.10)' : 'transparent',
            fontSize: '12px',
            lineHeight: '1.45',
          },
        },
        h(
          'span',
          {
            style: {
              color: toolColor,
              fontWeight: 600,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            },
          },
          item.tool,
        ),
        h(Chip, { item }),
        h('span', { style: { color: '#8a94a6', whiteSpace: 'nowrap' } }, ago(item.lastActivity)),
        h(
          'span',
          { style: { minWidth: 0 } },
          h(
            'span',
            {
              style: {
                display: 'block',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
              title: `${item.workspace} · ${item.title}`,
            },
            item.title,
          ),
          h(
            'span',
            {
              style: {
                display: 'block',
                color: '#9aa3b2',
                fontSize: '11px',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
              title: `${item.workspace}${item.detail ? ` · ${item.detail}` : ''}`,
            },
            `${item.workspace}${item.detail ? `  ·  ${item.detail}` : ''}`,
          ),
        ),
      )
    }

    function Summary({ board }) {
      const cells = [
        { label: '在跑', value: board.running, color: STATUS.running.color },
        { label: '等你', value: board.attention, color: STATUS['needs-you'].color },
        { label: '会话', value: board.items.length, color: '#6b7280' },
      ]
      if (board.spend) {
        cells.push({
          label: '今日',
          value: `${board.spend.symbol}${board.spend.cost.toFixed(2)}`,
          color: '#6b7280',
        })
      }
      return h(
        'div',
        { style: { display: 'flex', gap: '10px', padding: '2px 8px 8px' } },
        cells.map((cell) =>
          h(
            'div',
            {
              key: cell.label,
              style: {
                flex: 1,
                border: '1px solid rgba(127,127,127,0.18)',
                borderRadius: '6px',
                padding: '6px 8px',
              },
            },
            h('div', { style: { fontSize: '17px', fontWeight: 700, color: cell.color } }, String(cell.value)),
            h('div', { style: { fontSize: '11px', color: '#9aa3b2' } }, cell.label),
          ),
        ),
      )
    }

    function SourceStrip({ sources }) {
      return h(
        'div',
        {
          style: {
            display: 'flex',
            flexWrap: 'wrap',
            gap: '6px',
            padding: '0 8px 8px',
            fontSize: '11px',
            color: '#9aa3b2',
          },
        },
        sources.map((source) =>
          h(
            'span',
            {
              key: source.tool,
              title: source.available ? `${source.count || 0} sessions` : source.reason || 'unavailable',
              style: {
                border: '1px solid rgba(127,127,127,0.18)',
                borderRadius: '10px',
                padding: '1px 7px',
                color: source.available ? '#8a94a6' : '#c0392b',
              },
            },
            `${source.tool}${source.available ? '' : ' ✕'}`,
          ),
        ),
      )
    }

    function Group({ title, items, defaultOpen, tone, note }) {
      const [open, setOpen] = useState(defaultOpen)
      if (items.length === 0) return null
      const counts = {}
      for (const item of items) counts[item.tool] = (counts[item.tool] || 0) + 1
      const breakdown = Object.entries(counts)
        .map(([tool, count]) => `${tool} ${count}`)
        .join(' · ')
      return h(
        'div',
        { style: { marginBottom: '2px' } },
        h(
          'button',
          {
            type: 'button',
            onClick: () => setOpen((value) => !value),
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              width: '100%',
              border: 'none',
              background: 'transparent',
              color: 'inherit',
              cursor: 'pointer',
              padding: '6px 8px',
              fontSize: '11px',
              fontWeight: 600,
              textAlign: 'left',
              opacity: open ? 1 : 0.72,
            },
          },
          h('span', { style: { width: '10px', color: '#9aa3b2' } }, open ? '▾' : '▸'),
          h('span', { style: { color: tone || 'inherit' } }, title),
          h('span', { style: { color: '#9aa3b2', fontWeight: 400 } }, `${items.length}`),
          h(
            'span',
            {
              style: {
                color: '#b0b7c3',
                fontWeight: 400,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              },
            },
            note || breakdown,
          ),
        ),
        open
          ? [
              ...items.slice(0, 60).map((item) => h(Row, { key: `${item.tool}:${item.key}`, item })),
              items.length > 60
                ? h(
                    'div',
                    {
                      key: 'cap',
                      style: { padding: '4px 10px', fontSize: '10px', color: '#b0b7c3' },
                    },
                    `只显示前 60 条，共 ${items.length} 条`,
                  )
                : null,
            ]
          : null,
      )
    }

    /** Split the flat payload into the four bands a human actually triages. */
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

    function Board() {
      const state = useBoard()
      const board = state.data

      const header = useMemo(
        () =>
          h(
            'div',
            {
              style: {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '10px 8px 6px',
                fontSize: '12px',
                fontWeight: 600,
              },
            },
            h('span', null, '多 Agent 看板'),
            h(
              'button',
              {
                type: 'button',
                onClick: () => refresh(),
                style: {
                  border: '1px solid rgba(127,127,127,0.25)',
                  background: 'transparent',
                  borderRadius: '5px',
                  padding: '2px 8px',
                  fontSize: '11px',
                  cursor: 'pointer',
                  color: 'inherit',
                },
              },
              '刷新',
            ),
          ),
        [],
      )

      if (state.error && !board) {
        return h(
          'div',
          { style: { padding: '12px', fontSize: '12px', color: '#c0392b' } },
          `读取失败：${state.error}`,
        )
      }
      if (!board) {
        return h('div', { style: { padding: '12px', fontSize: '12px', color: '#9aa3b2' } }, '正在扫描本机 agent…')
      }

      return h(
        'div',
        {
          style: {
            height: '100%',
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            boxSizing: 'border-box',
          },
        },
        header,
        h(Summary, { board }),
        h(SourceStrip, { sources: board.sources || [] }),
        h(
          'div',
          { style: { padding: '0 4px 4px' } },
          board.items.length === 0
            ? h('div', { style: { padding: '10px', fontSize: '12px', color: '#9aa3b2' } }, '没有找到活跃会话')
            : (() => {
                const bands = band(board.items)
                return [
                  bands.attention.length === 0
                    ? h(
                        'div',
                        {
                          key: 'quiet',
                          style: { padding: '4px 8px 8px', fontSize: '11px', color: '#2f9e6f' },
                        },
                        '✓ 没有需要你处理的',
                      )
                    : null,
                  h(Group, {
                    key: 'attention',
                    title: '要你处理',
                    items: bands.attention,
                    defaultOpen: true,
                    tone: STATUS['needs-you'].color,
                  }),
                  h(Group, {
                    key: 'running',
                    title: '正在跑',
                    items: bands.running,
                    defaultOpen: true,
                    tone: STATUS.running.color,
                  }),
                  h(Group, {
                    key: 'recent',
                    title: '最近动过',
                    items: bands.recent,
                    defaultOpen: true,
                  }),
                  h(Group, {
                    key: 'older',
                    title: '更早',
                    items: bands.older,
                    defaultOpen: false,
                    note: '点开查看',
                  }),
                ]
              })(),
        ),
        h(
          'div',
          { style: { padding: '8px', fontSize: '10px', color: '#b0b7c3', textAlign: 'right' } },
          `显示 ${board.items.length}${board.total && board.total > board.items.length ? ` / 共 ${board.total}` : ''} · 本地推断 · 零 token · ${state.at ? new Date(state.at).toLocaleTimeString() : ''}`,
        ),
      )
    }

    /** The tab chip carries the attention count, so the number is visible while collapsed. */
    function TabTitle() {
      const state = useBoard()
      const count = state.data ? state.data.attention : 0
      return h('span', null, count > 0 ? `多 Agent 看板 (${count})` : '多 Agent 看板')
    }

    const tabDefinition = {
      id: TAB_ID,
      kind: KIND,
      priority: 'extension',
      title: () => '多 Agent 看板',
      guide: [
        {
          id: 'fleet',
          order: 20,
          title: () => '多 Agent 看板',
          description: () => '本机所有 agent 的任务进度（零 token）',
        },
      ],
    }

    const inject = ['slots', 'sidebarRightTabs']

    function apply(ctx) {
      ctx.effect(() => ctx.sidebarRightTabs.register(tabDefinition), 'dsh-fleet-board: tab type')
      ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID, registrant: TAB_ID }, Board)
      ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID, registrant: TAB_ID }, TabTitle)
      // Evidence hook for the headless live check: only set once both
      // registrations returned without throwing.
      globalThis.__dshFleetBoard = { registered: true, at: Date.now() }
    }

    return {
      name: 'dsh-fleet-board',
      inject,
      apply,
      /** Seams for the offline render check; the host never reads these. */
      __test: { Board, TabTitle, store, refresh },
    }
  },
})
