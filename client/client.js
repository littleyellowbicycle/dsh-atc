/**
 * dsh-fleet-board — browser half.
 *
 * Adds a global main panel (a sidebar row like Plugins / Automations) that
 * lists every local agent session. The host already did all inference; this
 * half only renders and navigates.
 *
 * Visual language: one dashboard, not one list.
 *   KPI tiles → activity heatmap → agent donut → status bar → session rows.
 * Every number on screen comes from the local payload; nothing is invented.
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
    const DAY = 86_400_000

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

    /**
     * Chart palette. The host exposes semantic state tokens for text and
     * borders, but a donut / heatmap needs discrete hues it does not ship,
     * so the categorical set lives here and is mirrored into CSS variables.
     */
    const PALETTE = {
      blue: '#4c7cf3',
      green: '#2f9e6f',
      amber: '#d98324',
      red: '#d9534f',
      purple: '#7c5cf0',
      teal: '#12b0a0',
      pink: '#e05fa8',
      slate: '#8b949e',
    }

    /** status → label, dot color, pill tint. */
    const STATUS = {
      running: { label: '在跑', color: PALETTE.green, soft: 'rgba(47,158,111,.12)' },
      'needs-you': { label: '等你', color: PALETTE.amber, soft: 'rgba(217,131,36,.14)' },
      failed: { label: '失败', color: PALETTE.red, soft: 'rgba(217,83,79,.12)' },
      done: { label: '完成', color: PALETTE.teal, soft: 'rgba(18,176,160,.12)' },
      stopped: { label: '已停', color: '#6e7781', soft: 'rgba(110,119,129,.12)' },
      recent: { label: '刚停', color: PALETTE.slate, soft: 'rgba(139,148,158,.12)' },
      idle: { label: '空闲', color: '#aeb6c0', soft: 'rgba(174,182,192,.14)' },
    }

    /** One hue per agent, shared by avatars, chips and the donut. */
    const TOOL_COLOR = {
      dsh: PALETTE.blue,
      codex: PALETTE.green,
      opencode: PALETTE.amber,
      workbuddy: PALETTE.purple,
    }

    /** Status order used by the stacked bar and the legend. */
    const STATUS_ORDER = ['running', 'needs-you', 'failed', 'done', 'stopped', 'recent', 'idle']

    /** Time windows; `all` keeps the historical default of showing everything. */
    const RANGES = [
      { key: 'today', label: '今天', ms: DAY },
      { key: 'd7', label: '近 7 天', ms: 7 * DAY },
      { key: 'd30', label: '近 30 天', ms: 30 * DAY },
      { key: 'all', label: '全部', ms: Infinity },
    ]

    /** Sort modes for the session list. */
    const SORTS = [
      { key: 'time', label: '最近更新' },
      { key: 'tool', label: '按工具' },
      { key: 'workspace', label: '按工作区' },
    ]

    /** Heatmap scale: empty cell first, then four blue steps. */
    const HEAT_EMPTY = '#f0f2f5'
    const HEAT_SCALE = ['#dbe7fd', '#b5cffb', '#82aaf7', '#5b8bf2', '#3b6ef6']

    function ago(ms) {
      if (!ms) return '—'
      const diff = Date.now() - ms
      if (diff < 0) return '刚刚'
      if (diff < 60_000) return `${Math.max(0, Math.round(diff / 1000))} 秒前`
      if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`
      if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`
      return `${Math.round(diff / 86_400_000)} 天前`
    }

    /** Wall-clock time, for the "last updated" stamp. */
    function clockTime(ms) {
      if (!ms) return '--:--:--'
      const date = new Date(ms)
      const pad = (value) => String(value).padStart(2, '0')
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    }

    /** Calendar day label, e.g. `11-14`. */
    function dayLabel(ms) {
      const date = new Date(ms)
      const pad = (value) => String(value).padStart(2, '0')
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    }

    /** Full date label, e.g. `2026-11-14`. */
    function fullDate(ms) {
      if (!ms) return '—'
      const date = new Date(ms)
      const pad = (value) => String(value).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    }

    /** Local midnight of the day containing `ms`. */
    function dayStart(ms) {
      const date = new Date(ms)
      date.setHours(0, 0, 0, 0)
      return date.getTime()
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

    /** Put a string on the clipboard; the fallback is the caller's own message. */
    async function copyText(text) {
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch {
        return false
      }
    }

    /* ------------------------------------------------------------- derivation */

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

    /** Apply the visible filters (search, window, status, agent). */
    function filterItems(items, filters) {
      const range = RANGES.find((entry) => entry.key === filters.range) ?? RANGES[RANGES.length - 1]
      const floor = Date.now() - range.ms
      const needle = filters.query.trim().toLowerCase()
      return items.filter((item) => {
        if (range.ms !== Infinity && item.lastActivity < floor) return false
        if (filters.status !== 'all' && item.status !== filters.status) return false
        if (filters.tool !== 'all' && item.tool !== filters.tool) return false
        if (!needle) return true
        const haystack = `${item.title} ${item.workspace} ${item.detail} ${item.tool}`.toLowerCase()
        return haystack.includes(needle)
      })
    }

    /** Sort inside a band without ever losing the band order itself. */
    function sortItems(items, sortKey) {
      const sorted = items.slice()
      if (sortKey === 'tool') {
        sorted.sort((a, b) => a.tool.localeCompare(b.tool) || b.lastActivity - a.lastActivity)
      } else if (sortKey === 'workspace') {
        sorted.sort(
          (a, b) => a.workspace.localeCompare(b.workspace) || b.lastActivity - a.lastActivity,
        )
      } else {
        sorted.sort((a, b) => b.lastActivity - a.lastActivity)
      }
      return sorted
    }

    /** Sessions per agent, for the donut and the legend. */
    function toolBreakdown(items) {
      const counts = new Map()
      for (const item of items) counts.set(item.tool, (counts.get(item.tool) || 0) + 1)
      return [...counts.entries()]
        .map(([tool, value]) => ({ key: tool, label: tool, value, color: TOOL_COLOR[tool] || PALETTE.slate }))
        .sort((a, b) => b.value - a.value)
    }

    /** Sessions per status, for the stacked bar and its legend. */
    function statusBreakdown(items) {
      const counts = new Map()
      for (const item of items) counts.set(item.status, (counts.get(item.status) || 0) + 1)
      return STATUS_ORDER.filter((status) => counts.has(status)).map((status) => ({
        key: status,
        label: STATUS[status].label,
        value: counts.get(status),
        color: STATUS[status].color,
      }))
    }

    /**
     * GitHub-style activity heatmap: columns are weeks, rows are weekdays.
     * @param items - the sessions to count.
     * @param weeks - how many weeks to show.
     * @returns columns (each with a month label) plus the busiest day count.
     */
    function activityHeatmap(items, weeks = 6) {
      const today = dayStart(Date.now())
      const start = today - (weeks * 7 - 1) * DAY
      // Align the first column to a Sunday so the weekday rows stay true.
      const offset = new Date(start).getDay()
      const gridStart = start - offset * DAY
      const counts = new Map()
      for (const item of items) {
        const key = dayStart(item.lastActivity)
        counts.set(key, (counts.get(key) || 0) + 1)
      }
      const columns = []
      let lastMonth = -1
      for (let column = 0; ; column += 1) {
        const first = gridStart + column * 7 * DAY
        if (first > today + DAY) break
        const cells = []
        for (let row = 0; row < 7; row += 1) {
          const time = first + row * DAY
          cells.push({ time, count: time > today ? -1 : counts.get(time) || 0 })
        }
        const month = new Date(first).getMonth()
        columns.push({ cells, label: month !== lastMonth ? `${month + 1}月` : '' })
        lastMonth = month
      }
      const max = Math.max(
        1,
        ...columns.flatMap((column) => column.cells.map((cell) => Math.max(0, cell.count))),
      )
      let busiest = { time: 0, count: 0 }
      for (const [time, count] of counts) {
        if (count > busiest.count) busiest = { time, count }
      }
      return { columns, max, busiest }
    }

    /** Bucket a day count onto the 5-step blue scale. */
    function heatColor(count, max) {
      if (count <= 0) return HEAT_EMPTY
      const ratio = count / max
      const step = Math.min(HEAT_SCALE.length - 1, Math.floor(ratio * HEAT_SCALE.length))
      return HEAT_SCALE[step]
    }

    /* ------------------------------------------------------------- components */

    function RefreshIcon({ size = 13 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M20 11a8 8 0 1 0-2.3 6.1' }),
        h('path', { d: 'M20 4v7h-7' }),
      )
    }

    function SearchIcon({ size = 13 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('circle', { cx: 11, cy: 11, r: 7 }),
        h('path', { d: 'M20 20l-3.6-3.6' }),
      )
    }

    function CheckIcon({ size = 13 }) {
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2.2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M4 12.5l5 5L20 6.5' }),
      )
    }

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

    /** Segmented control, dark filled active state. */
    function Segmented({ options, value, onChange }) {
      return h(
        'div',
        { className: 'fb-seg' },
        options.map((option) =>
          h(
            'button',
            {
              key: option.key,
              type: 'button',
              className: `fb-seg-item${option.key === value ? ' fb-seg-item-active' : ''}`,
              onClick: () => onChange(option.key),
            },
            option.label,
          ),
        ),
      )
    }

    /** One KPI tile: big number, label, optional footnote. */
    function Kpi({ value, label, note, color }) {
      return h(
        'div',
        { className: 'fb-kpi' },
        h('div', { className: 'fb-kpi-value', style: color ? { color } : undefined }, value),
        h('div', { className: 'fb-kpi-label' }, label),
        note ? h('div', { className: 'fb-kpi-note' }, note) : null,
      )
    }

    /** Donut with a centered total. */
    function Donut({ segments, total, centerLabel }) {
      const size = 132
      const stroke = 15
      const radius = (size - stroke) / 2
      const circumference = 2 * Math.PI * radius
      let offset = 0
      const arcs = segments.map((segment) => {
        const length = total > 0 ? (segment.value / total) * circumference : 0
        const arc = h('circle', {
          key: segment.key,
          cx: size / 2,
          cy: size / 2,
          r: radius,
          fill: 'none',
          stroke: segment.color,
          strokeWidth: stroke,
          strokeDasharray: `${length} ${circumference - length}`,
          strokeDashoffset: -offset,
          transform: `rotate(-90 ${size / 2} ${size / 2})`,
        })
        offset += length
        return arc
      })
      return h(
        'svg',
        { width: size, height: size, viewBox: `0 0 ${size} ${size}`, className: 'fb-donut' },
        h('circle', {
          cx: size / 2,
          cy: size / 2,
          r: radius,
          fill: 'none',
          stroke: '#eef0f3',
          strokeWidth: stroke,
        }),
        arcs,
        h(
          'text',
          { x: size / 2, y: size / 2 - 1, textAnchor: 'middle', className: 'fb-donut-value' },
          String(total),
        ),
        h(
          'text',
          { x: size / 2, y: size / 2 + 15, textAnchor: 'middle', className: 'fb-donut-label' },
          centerLabel,
        ),
      )
    }

    /** Legend row: swatch, name, share, raw count. */
    function LegendRow({ color, name, share, count, title }) {
      return h(
        'div',
        { className: 'fb-legend-row', title: title || name },
        h('i', { className: 'fb-legend-dot', style: { background: color } }),
        h('span', { className: 'fb-legend-name' }, name),
        h('span', { className: 'fb-legend-pct' }, share),
        h('span', { className: 'fb-legend-count' }, count),
      )
    }

    /**
     * Session card: title + relative time on top, agent / workspace tags in
     * the middle, status and context pressure on the footer.
     */
    function SessionCard({ item, onOpen }) {
      const status = STATUS[item.status] || STATUS.idle
      const color = TOOL_COLOR[item.tool] || PALETTE.slate
      const clickable = Boolean(item.sessionId)
      const ctx = /ctx\s*(\d+)%/.exec(item.detail || '')
      const extra = item.detail
        ? item.detail.replace(/ctx\s*\d+%/, '').replace(/^[·\s]+|[·\s]+$/g, '')
        : ''
      return h(
        'div',
        {
          className: `fb-session${clickable ? ' fb-session-clickable' : ''}`,
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
          { className: 'fb-session-top' },
          h('div', { className: 'fb-session-title' }, item.title),
          h('div', { className: 'fb-session-time' }, ago(item.lastActivity)),
        ),
        h('div', { className: 'fb-session-date' }, fullDate(item.lastActivity)),
        h(
          'div',
          { className: 'fb-session-tags' },
          h(
            'span',
            { className: 'fb-tag' },
            h('i', { className: 'fb-legend-dot', style: { background: color } }),
            item.tool,
          ),
          h('span', { className: 'fb-tag fb-tag-muted', title: item.workspace }, item.workspace),
        ),
        h(
          'div',
          { className: 'fb-session-foot' },
          h(
            'span',
            { className: 'fb-status', style: { color: status.color, background: status.soft } },
            h('i', { className: 'fb-status-dot', style: { background: status.color } }),
            status.label,
          ),
          ctx
            ? h(
                'span',
                { className: 'fb-session-ctx', title: `上下文占用 ${ctx[1]}%` },
                h('span', { className: 'fb-session-ctx-label' }, `ctx ${ctx[1]}%`),
                h(
                  'span',
                  { className: 'fb-meter' },
                  h('i', { style: { width: `${Math.min(100, Number(ctx[1]))}%` } }),
                ),
              )
            : extra
              ? h('span', { className: 'fb-session-detail' }, extra)
              : null,
        ),
      )
    }

    /** Collapsible band of sessions. */
    function Group({ title, items, color, defaultOpen, onOpen, hint }) {
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
          h('i', { className: 'fb-group-bar', style: { background: color } }),
          h('span', { className: 'fb-group-title' }, title),
          h('span', { className: 'fb-count' }, String(items.length)),
          h('span', { className: 'fb-group-hint' }, hint || breakdown),
        ),
        open
          ? h(
              'div',
              { className: 'fb-session-grid' },
              shown.map((item) => h(SessionCard, { key: `${item.tool}:${item.key}`, item, onOpen })),
            )
          : null,
        open && items.length > ROW_CAP
          ? h('div', { className: 'fb-cap' }, `只显示前 ${ROW_CAP} 条，共 ${items.length} 条`)
          : null,
      )
    }

    /** Loading placeholder that mirrors the KPI grid shape. */
    function Skeleton() {
      return h(
        'div',
        { className: 'fb-kpis' },
        Array.from({ length: 6 }, (_, index) =>
          h(
            'div',
            { className: 'fb-kpi', key: index },
            h('div', { className: 'fb-skel', style: { width: '48px', height: '18px' } }),
            h('div', { className: 'fb-skel', style: { width: '64px', marginTop: '8px' } }),
          ),
        ),
      )
    }

    /* ------------------------------------------------------------------ page */

    function FleetPage(props) {
      const ctx = props.ctx
      const state = useBoard()
      const [notice, setNotice] = useState('')
      const [query, setQuery] = useState('')
      const [range, setRange] = useState('all')
      const [statusFilter, setStatusFilter] = useState('all')
      const [toolFilter, setToolFilter] = useState('all')
      const [sort, setSort] = useState('time')
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

      const filters = { query, range, status: statusFilter, tool: toolFilter }
      const filtered = useMemo(() => (board ? filterItems(board.items, filters) : []), [
        board,
        query,
        range,
        statusFilter,
        toolFilter,
      ])
      const bands = useMemo(() => band(filtered), [filtered])
      const sortedBands = useMemo(
        () => ({
          attention: sortItems(bands.attention, sort),
          running: sortItems(bands.running, sort),
          recent: sortItems(bands.recent, sort),
          older: sortItems(bands.older, sort),
        }),
        [bands, sort],
      )

      const tools = useMemo(() => toolBreakdown(filtered), [filtered])
      const statuses = useMemo(() => statusBreakdown(filtered), [filtered])
      // Widen the heatmap just enough to cover the oldest visible session, so
      // the grid is never half empty and never invents history that is not there.
      const heatWeeks = useMemo(() => {
        if (filtered.length === 0) return 4
        let earliest = Infinity
        for (const item of filtered) earliest = Math.min(earliest, item.lastActivity)
        const weeks = Math.ceil((Date.now() - earliest) / (7 * DAY)) + 1
        return Math.min(10, Math.max(4, weeks))
      }, [filtered])
      const heat = useMemo(() => activityHeatmap(filtered, heatWeeks), [filtered, heatWeeks])
      const heatToday = useMemo(() => {
        const today = dayStart(Date.now())
        return filtered.filter((item) => dayStart(item.lastActivity) === today).length
      }, [filtered])
      const heatWeek = useMemo(
        () => filtered.filter((item) => item.lastActivity >= Date.now() - 7 * DAY).length,
        [filtered],
      )

      const running = board ? board.running : 0
      const attention = board ? board.attention : 0
      const doneCount = board ? board.items.filter((item) => item.status === 'done').length : 0
      const failedCount = board ? board.items.filter((item) => item.status === 'failed').length : 0
      const activeTools = board
        ? (board.sources || []).filter((source) => source.available).length
        : 0
      const totalTools = board ? (board.sources || []).length : 0
      const lastSeen = board && board.items.length ? board.items[0].lastActivity : 0

      const filtersActive = query || range !== 'all' || statusFilter !== 'all' || toolFilter !== 'all'
      const statusCounts = useMemo(() => {
        const counts = new Map()
        for (const item of filtered) counts.set(item.status, (counts.get(item.status) || 0) + 1)
        return counts
      }, [filtered])
      const toolCounts = useMemo(() => {
        const counts = new Map()
        for (const item of filtered) counts.set(item.tool, (counts.get(item.tool) || 0) + 1)
        return counts
      }, [filtered])

      const resetFilters = useCallback(() => {
        setQuery('')
        setRange('all')
        setStatusFilter('all')
        setToolFilter('all')
      }, [])

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
            h(
              'div',
              { className: 'fb-title' },
              h('h1', { className: 'fb-h1' }, '多 Agent 看板'),
              h(
                'span',
                { className: 'fb-badge' },
                h('i', { className: 'fb-badge-dot' }),
                '本地推断 · 零 token',
              ),
            ),
            h('p', { className: 'fb-sub' }, '本机所有 agent 的会话 · 每 5 秒自动刷新'),
          ),
          h(
            'div',
            { className: 'fb-head-tools' },
            h(
              'span',
              { className: 'fb-live' },
              h('i', { className: 'fb-live-dot' }),
              `更新于 ${clockTime(state.at)}`,
            ),
            h(Segmented, { options: RANGES, value: range, onChange: setRange }),
            h(
              'button',
              { type: 'button', className: 'fb-btn', onClick: () => refresh() },
              h(RefreshIcon, null),
              '刷新',
            ),
          ),
        ),

        state.error && !board
          ? h('div', { className: 'fb-error' }, `读取失败：${state.error}`)
          : null,

        !board
          ? h(Skeleton, null)
          : h(
              'div',
              { className: 'fb-body' },
              h(
                'div',
                { className: 'fb-kpis' },
                h(Kpi, { value: String(running), label: '在跑', color: STATUS.running.color, note: '正在推进的会话' }),
                h(Kpi, { value: String(attention), label: '等你', color: STATUS['needs-you'].color, note: '等你拍板' }),
                h(Kpi, { value: String(failedCount), label: '失败', color: STATUS.failed.color, note: '需要你处理' }),
                h(Kpi, { value: String(doneCount), label: '完成', color: STATUS.done.color, note: '已收尾的会话' }),
                h(Kpi, {
                  value: String(board.total || board.items.length),
                  label: '本机会话',
                  note: `显示 ${board.items.length} 条`,
                }),
                h(Kpi, {
                  value: `${activeTools}/${totalTools}`,
                  label: '接入的 agent',
                  note: activeTools === totalTools ? '全部可用' : `${totalTools - activeTools} 个不可用`,
                }),
              ),

              h(
                'div',
                { className: 'fb-charts' },
                h(
                  'div',
                  { className: 'fb-card' },
                  h(
                    'div',
                    { className: 'fb-card-head' },
                    h('span', { className: 'fb-card-title' }, '活跃度'),
                    h('span', { className: 'fb-card-meta' }, `近 ${heatWeeks} 周`),
                  ),
                  h(
                    'div',
                    { className: 'fb-heat-wrap' },
                    h(
                      'div',
                      { className: 'fb-heat' },
                      h(
                        'div',
                        { className: 'fb-heat-days' },
                        h('span', null, '日'),
                        h('span', null, '一'),
                        h('span', null, '二'),
                        h('span', null, '三'),
                        h('span', null, '四'),
                        h('span', null, '五'),
                        h('span', null, '六'),
                      ),
                      h(
                        'div',
                        { className: 'fb-heat-grid' },
                        h(
                          'div',
                          { className: 'fb-heat-labels' },
                          heat.columns.map((column, index) =>
                            h('span', { className: 'fb-heat-col-label', key: `label-${index}` }, column.label),
                          ),
                        ),
                        h(
                          'div',
                          { className: 'fb-heat-cols' },
                          heat.columns.map((column, index) =>
                            h(
                              'div',
                              { className: 'fb-heat-col', key: `col-${index}` },
                              column.cells.map((cell, row) =>
                                h('i', {
                                  key: `cell-${index}-${row}`,
                                  className: 'fb-heat-cell',
                                  style: {
                                    background: cell.count < 0 ? 'transparent' : heatColor(cell.count, heat.max),
                                  },
                                  title:
                                    cell.count < 0
                                      ? ''
                                      : `${fullDate(cell.time)} · ${cell.count} 个会话`,
                                }),
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                    h(
                      'div',
                      { className: 'fb-heat-side' },
                      h(
                        'div',
                        { className: 'fb-heat-stat' },
                        h('b', null, String(heatToday)),
                        '今天动过',
                      ),
                      h(
                        'div',
                        { className: 'fb-heat-stat' },
                        h('b', null, String(heatWeek)),
                        '近 7 天动过',
                      ),
                      h(
                        'div',
                        { className: 'fb-heat-stat' },
                        h('b', null, String(heat.busiest.count)),
                        `个 · 最忙 ${heat.busiest.count ? dayLabel(heat.busiest.time) : '—'}`,
                      ),
                    ),
                  ),
                  h(
                    'div',
                    { className: 'fb-heat-legend' },
                    h('span', null, '少'),
                    [HEAT_EMPTY, ...HEAT_SCALE].map((color) =>
                      h('i', { key: color, style: { background: color } }),
                    ),
                    h('span', null, '多'),
                  ),
                ),
                h(
                  'div',
                  { className: 'fb-card' },
                  h(
                    'div',
                    { className: 'fb-card-head' },
                    h('span', { className: 'fb-card-title' }, 'Agent 分布'),
                    h('span', { className: 'fb-card-meta' }, `${filtered.length} 个会话`),
                  ),
                  h(
                    'div',
                    { className: 'fb-donut-wrap' },
                    h(Donut, { segments: tools, total: filtered.length, centerLabel: '会话' }),
                    h(
                      'div',
                      { className: 'fb-legend' },
                      tools.length === 0
                        ? h('div', { className: 'fb-legend-row' }, '没有数据')
                        : tools.map((tool) =>
                            h(LegendRow, {
                              key: tool.key,
                              color: tool.color,
                              name: tool.label,
                              share: `${filtered.length ? Math.round((tool.value / filtered.length) * 100) : 0}%`,
                              count: String(tool.value),
                            }),
                          ),
                    ),
                  ),
                ),
              ),

              h(
                'div',
                { className: 'fb-card fb-statusbar' },
                h(
                  'div',
                  { className: 'fb-card-head' },
                  h('span', { className: 'fb-card-title' }, '状态分布'),
                  h('span', { className: 'fb-card-meta' }, '全部筛选结果'),
                ),
                h(
                  'div',
                  { className: 'fb-statusbar-track' },
                  statuses.length === 0
                    ? null
                    : statuses.map((status) =>
                        h('i', {
                          key: status.key,
                          className: 'fb-statusbar-seg',
                          style: {
                            width: `${(status.value / Math.max(1, filtered.length)) * 100}%`,
                            background: status.color,
                          },
                          title: `${status.label} ${status.value}`,
                        }),
                      ),
                ),
                h(
                  'div',
                  { className: 'fb-statusbar-legend' },
                  statuses.length === 0
                    ? h('span', null, '没有数据')
                    : statuses.map((status) =>
                        h(
                          'span',
                          { className: 'fb-statusbar-item', key: status.key },
                          h('i', { className: 'fb-legend-dot', style: { background: status.color } }),
                          `${status.label} ${status.value}`,
                        ),
                      ),
                ),
              ),

              h(
                'div',
                { className: 'fb-list-head' },
                h('span', { className: 'fb-list-title' }, '会话'),
                h('span', { className: 'fb-count' }, String(filtered.length)),
                h(
                  'span',
                  { className: 'fb-list-meta' },
                  board.total > board.items.length
                    ? `本机共 ${board.total} 个会话，只取最近 ${board.items.length} 个`
                    : `本机共 ${board.items.length} 个会话`,
                ),
                h(
                  'div',
                  { className: 'fb-list-tools' },
                  h(
                    'label',
                    { className: 'fb-search' },
                    h(SearchIcon, null),
                    h('input', {
                      value: query,
                      placeholder: '搜索标题、工作区…',
                      onChange: (event) => setQuery(event.target.value),
                    }),
                  ),
                  h(Segmented, { options: SORTS, value: sort, onChange: setSort }),
                ),
              ),

              h(
                'div',
                { className: 'fb-filters' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: `fb-chip${toolFilter === 'all' ? ' fb-chip-active' : ''}`,
                    onClick: () => setToolFilter('all'),
                  },
                  '全部 agent',
                  h('span', { className: 'fb-chip-count' }, String(filtered.length)),
                ),
                (board.sources || []).map((source) =>
                  h(
                    'button',
                    {
                      key: source.tool,
                      type: 'button',
                      className: `fb-chip${toolFilter === source.tool ? ' fb-chip-active' : ''}${
                        source.available ? '' : ' fb-chip-off'
                      }`,
                      title: source.available
                        ? `${source.count || 0} 个会话`
                        : source.reason || '不可用',
                      onClick: () => (source.available ? setToolFilter(source.tool) : null),
                    },
                    h('i', {
                      className: 'fb-legend-dot',
                      style: { background: TOOL_COLOR[source.tool] || PALETTE.slate },
                    }),
                    source.tool,
                    h('span', { className: 'fb-chip-count' }, String(toolCounts.get(source.tool) || 0)),
                  ),
                ),
                (() => {
                  // Agents found on this machine that no parser reads yet: shown
                  // so the chip row never passes for a complete inventory.
                  const unparsed = (board.agents || []).filter((agent) => !agent.parsed)
                  if (unparsed.length === 0) return null
                  return [
                    h('span', { key: 'unparsed-sep', className: 'fb-chip-sep' }),
                    ...unparsed.map((agent) =>
                      h(
                        'span',
                        {
                          key: `unparsed-${agent.tool}`,
                          className: 'fb-chip fb-chip-off fb-chip-muted',
                          title: `检测到 ${agent.path}，但还没有解析器`,
                        },
                        agent.tool,
                        h('span', { className: 'fb-chip-count' }, '未接入'),
                      ),
                    ),
                  ]
                })(),
                h('span', { className: 'fb-chip-sep' }),
                h(
                  'button',
                  {
                    type: 'button',
                    className: `fb-chip${statusFilter === 'all' ? ' fb-chip-active' : ''}`,
                    onClick: () => setStatusFilter('all'),
                  },
                  '全部状态',
                ),
                STATUS_ORDER.filter((status) => statusCounts.has(status)).map((status) =>
                  h(
                    'button',
                    {
                      key: status,
                      type: 'button',
                      className: `fb-chip${statusFilter === status ? ' fb-chip-active' : ''}`,
                      onClick: () => setStatusFilter(status),
                    },
                    h('i', { className: 'fb-legend-dot', style: { background: STATUS[status].color } }),
                    STATUS[status].label,
                    h('span', { className: 'fb-chip-count' }, String(statusCounts.get(status))),
                  ),
                ),
                filtersActive
                  ? h(
                      'button',
                      { type: 'button', className: 'fb-chip fb-chip-reset', onClick: resetFilters },
                      '清空筛选',
                    )
                  : null,
              ),

              filtered.length === 0
                ? h('div', { className: 'fb-clear' }, '当前筛选下没有会话')
                : null,

              bands.attention.length === 0 && filtered.length > 0
                ? h(
                    'div',
                    { className: 'fb-clear' },
                    h(CheckIcon, null),
                    '没有需要你处理的',
                  )
                : null,

              h(Group, {
                title: '要你处理',
                items: sortedBands.attention,
                color: STATUS['needs-you'].color,
                defaultOpen: true,
                onOpen,
              }),
              h(Group, {
                title: '正在跑',
                items: sortedBands.running,
                color: STATUS.running.color,
                defaultOpen: true,
                onOpen,
              }),
              h(Group, {
                title: '最近动过',
                items: sortedBands.recent,
                color: STATUS.recent.color,
                defaultOpen: true,
                onOpen,
              }),
              h(Group, {
                title: '更早',
                items: sortedBands.older,
                color: STATUS.idle.color,
                defaultOpen: false,
                onOpen,
                hint: '点开查看',
              }),
            ),

        h(
          'footer',
          { className: 'fb-foot' },
          h('span', null, '点 DSH 行打开会话 · 点其它行复制工作区路径'),
          h('span', null, `最后活动 ${ago(lastSeen)}`),
        ),

        notice ? h('div', { className: 'fb-toast' }, notice) : null,
      )
    }

    /* ------------------------------------------------------------------ css */

    const CSS = `
.fb-page{box-sizing:border-box;--fb-line:var(--dsw-alias-border-l1,#e8ebf0);--fb-line-soft:var(--dsw-alias-border-l2,#eff1f4);--fb-surface:var(--dsw-alias-card-fill,#fff);--fb-fill:var(--dsw-alias-interactive-bg-hover,#f3f5f8);--fb-elevated:var(--dsw-alias-button-elevated-fill,#f4f5f7);--fb-hover:var(--dsw-alias-interactive-bg-hover,#f3f5f8);--fb-text:var(--dsw-alias-label-primary,#1f2328);--fb-text-2:var(--dsw-alias-label-secondary,#57606a);--fb-text-3:var(--dsw-alias-label-tertiary,#8b949e);--fb-text-4:var(--dsw-alias-label-quaternary,#a8b0ba);max-width:1180px;margin:0 auto;padding:18px 22px 36px;color:var(--fb-text);font-size:13px;line-height:1.5;-webkit-font-smoothing:antialiased}
.fb-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:14px}
.fb-title{display:flex;align-items:center;gap:8px}
.fb-h1{margin:0;font-size:16px;font-weight:650;letter-spacing:.01em}
.fb-badge{display:inline-flex;align-items:center;gap:5px;font-size:11px;padding:2px 9px;border-radius:999px;border:1px solid var(--fb-line);background:var(--fb-fill);color:var(--fb-text-3)}
.fb-badge-dot{width:6px;height:6px;border-radius:50%;background:#2f9e6f;display:inline-block}
.fb-sub{margin:4px 0 0;font-size:12px;color:var(--fb-text-3)}
.fb-head-tools{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-left:auto}
.fb-live{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--fb-text-3);font-variant-numeric:tabular-nums}
.fb-live-dot{width:6px;height:6px;border-radius:50%;background:#2f9e6f;display:inline-block;animation:fb-pulse 1.8s ease-in-out infinite}
@keyframes fb-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.3;transform:scale(.75)}}
.fb-btn{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--fb-line);background:var(--fb-elevated);color:var(--fb-text-2);border-radius:7px;padding:4px 11px;font-size:12px;cursor:pointer;font-family:inherit;transition:background .15s,color .15s}
.fb-btn:hover{background:var(--fb-hover);color:var(--fb-text)}
.fb-seg{display:inline-flex;align-items:center;gap:2px;padding:2px;border:1px solid var(--fb-line);border-radius:8px;background:var(--fb-fill)}
.fb-seg-item{border:none;background:transparent;color:var(--fb-text-3);font-family:inherit;font-size:11.5px;padding:3px 10px;border-radius:6px;cursor:pointer;white-space:nowrap;transition:background .15s,color .15s}
.fb-seg-item:hover{color:var(--fb-text)}
.fb-seg-item-active{background:var(--fb-text);color:var(--fb-surface)}
.fb-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:12px}
.fb-kpi{border:1px solid var(--fb-line);border-radius:12px;padding:12px 14px;background:var(--fb-fill)}
.fb-kpi-value{font-size:22px;font-weight:650;line-height:1.15;font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.fb-kpi-label{margin-top:3px;font-size:11.5px;color:var(--fb-text-2)}
.fb-kpi-note{margin-top:1px;font-size:10.5px;color:var(--fb-text-4);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fb-charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:12px;margin-bottom:12px}
.fb-card{border:1px solid var(--fb-line);border-radius:12px;background:var(--fb-surface);padding:14px 16px}
.fb-card-head{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:12px}
.fb-card-title{font-size:13px;font-weight:600}
.fb-card-meta{font-size:11px;color:var(--fb-text-4)}
.fb-heat-wrap{display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap}
.fb-heat{display:flex;gap:6px;align-items:flex-start;flex:none}
.fb-heat-days{display:grid;grid-template-rows:repeat(7,14px);gap:4px;padding-top:16px;font-size:9.5px;color:var(--fb-text-4);line-height:14px;text-align:right}
.fb-heat-grid{display:flex;flex-direction:column;gap:4px}
.fb-heat-labels{display:flex;gap:4px;height:12px}
.fb-heat-col-label{width:14px;font-size:9.5px;color:var(--fb-text-4);line-height:12px;white-space:nowrap;text-align:center}
.fb-heat-cols{display:flex;gap:4px}
.fb-heat-col{display:flex;flex-direction:column;gap:4px}
.fb-heat-cell{width:14px;height:14px;border-radius:3px;display:block}
.fb-heat-side{margin-left:auto;display:flex;flex-direction:column;gap:9px;flex:none}
.fb-heat-stat{display:flex;align-items:baseline;gap:7px;font-size:11.5px;color:var(--fb-text-3)}
.fb-heat-stat b{font-size:15px;font-weight:650;color:var(--fb-text);font-variant-numeric:tabular-nums}
.fb-heat-legend{display:flex;align-items:center;gap:4px;font-size:10.5px;color:var(--fb-text-4);margin-top:14px}
.fb-heat-legend i{width:10px;height:10px;border-radius:2px;display:inline-block}
.fb-donut-wrap{display:flex;align-items:center;gap:18px;flex-wrap:wrap}
.fb-donut{flex:none}
.fb-donut-value{font-size:19px;font-weight:650;fill:var(--fb-text)}
.fb-donut-label{font-size:10px;fill:var(--fb-text-4)}
.fb-legend{flex:1;min-width:150px;display:flex;flex-direction:column;gap:7px}
.fb-legend-row{display:flex;align-items:center;gap:8px;font-size:12px}
.fb-legend-dot{width:8px;height:8px;border-radius:2px;display:inline-block;flex:none}
.fb-legend-name{color:var(--fb-text-2)}
.fb-legend-pct{margin-left:auto;font-weight:600;font-variant-numeric:tabular-nums}
.fb-legend-count{color:var(--fb-text-4);font-size:11px;font-variant-numeric:tabular-nums;min-width:30px;text-align:right}
.fb-statusbar{margin-bottom:4px}
.fb-statusbar-track{display:flex;height:8px;border-radius:999px;overflow:hidden;background:var(--fb-line-soft)}
.fb-statusbar-seg{height:100%;display:block}
.fb-statusbar-legend{display:flex;flex-wrap:wrap;gap:14px;margin-top:11px;font-size:11.5px;color:var(--fb-text-3)}
.fb-statusbar-item{display:inline-flex;align-items:center;gap:6px}
.fb-list-head{display:flex;align-items:center;gap:9px;flex-wrap:wrap;margin:16px 0 10px}
.fb-list-title{font-size:14px;font-weight:650}
.fb-list-meta{font-size:11px;color:var(--fb-text-4)}
.fb-list-tools{margin-left:auto;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.fb-search{display:flex;align-items:center;gap:6px;border:1px solid var(--fb-line);border-radius:8px;padding:4px 10px;background:var(--fb-surface);min-width:190px;color:var(--fb-text-4)}
.fb-search:focus-within{border-color:var(--fb-blue,#4c7cf3)}
.fb-search input{border:none;outline:none;background:transparent;font-family:inherit;font-size:12px;color:var(--fb-text);width:100%}
.fb-search input::placeholder{color:var(--fb-text-4)}
.fb-filters{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-bottom:10px}
.fb-chip{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;padding:3px 10px;border-radius:999px;border:1px solid var(--fb-line);background:var(--fb-surface);color:var(--fb-text-2);cursor:pointer;font-family:inherit;transition:background .15s,color .15s}
.fb-chip:hover{background:var(--fb-hover)}
.fb-chip-active{background:var(--fb-text);border-color:var(--fb-text);color:var(--fb-surface)}
.fb-chip-active:hover{background:var(--fb-text);opacity:.9}
.fb-chip-off{color:var(--fb-text-4);border-style:dashed;cursor:default}
.fb-chip-off:hover{background:transparent}
.fb-chip-muted{opacity:.75;cursor:default}
.fb-chip-count{font-size:10.5px;color:var(--fb-text-4);font-variant-numeric:tabular-nums}
.fb-chip-sep{width:1px;height:15px;background:var(--fb-line);margin:0 3px;flex:none}
.fb-chip-active .fb-chip-count{color:rgba(255,255,255,.72)}
.fb-chip-reset{border-style:dashed;color:var(--fb-text-3)}
.fb-clear{display:flex;align-items:center;gap:8px;padding:10px 12px;margin-bottom:10px;border:1px solid rgba(47,158,111,.25);background:rgba(47,158,111,.07);border-radius:10px;font-size:12px;color:#2f9e6f}
.fb-group{margin-bottom:8px}
.fb-group-head{display:flex;align-items:center;gap:8px;width:100%;border:none;background:transparent;color:inherit;font-family:inherit;font-size:12px;font-weight:600;padding:8px 4px;cursor:pointer;text-align:left}
.fb-caret{width:9px;color:var(--fb-text-4);font-size:9px}
.fb-group-bar{width:3px;height:12px;border-radius:2px;display:inline-block}
.fb-group-title{color:var(--fb-text)}
.fb-count{font-size:11px;font-weight:600;color:var(--fb-text-3);background:var(--fb-fill);border:1px solid var(--fb-line);border-radius:999px;padding:0 7px;font-variant-numeric:tabular-nums}
.fb-group-hint{margin-left:auto;font-size:11px;font-weight:400;color:var(--fb-text-4)}
.fb-session-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(268px,1fr));gap:9px}
.fb-session{display:flex;flex-direction:column;gap:7px;border:1px solid var(--fb-line);border-radius:12px;background:var(--fb-surface);padding:12px 13px;transition:border-color .15s,box-shadow .15s}
.fb-session-clickable{cursor:pointer}
.fb-session-clickable:hover{border-color:#c3d0f6;box-shadow:0 4px 14px rgba(20,28,45,.07)}
.fb-session-top{display:flex;align-items:flex-start;gap:10px}
.fb-session-title{flex:1;min-width:0;font-size:12.5px;font-weight:600;line-height:1.45;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-word}
.fb-session-time{flex:none;font-size:11px;color:var(--fb-text-4);font-variant-numeric:tabular-nums;white-space:nowrap;padding-top:1px}
.fb-session-date{font-size:10.5px;color:var(--fb-text-4);font-variant-numeric:tabular-nums;margin-top:-3px}
.fb-session-tags{display:flex;align-items:center;gap:5px;flex-wrap:wrap}
.fb-tag{display:inline-flex;align-items:center;gap:5px;font-size:10.5px;color:var(--fb-text-2);background:var(--fb-fill);border:1px solid var(--fb-line);border-radius:6px;padding:1px 7px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fb-tag-muted{color:var(--fb-text-3)}
.fb-session-foot{margin-top:auto;padding-top:9px;border-top:1px solid var(--fb-line-soft);display:flex;align-items:center;gap:10px}
.fb-session-ctx{margin-left:auto;display:flex;align-items:center;gap:6px;font-size:10.5px;color:var(--fb-text-3);font-variant-numeric:tabular-nums}
.fb-session-detail{margin-left:auto;font-size:10.5px;color:var(--fb-text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:52%}
.fb-meter{width:52px;height:4px;border-radius:999px;background:var(--fb-line-soft);overflow:hidden;flex:none;display:inline-block}
.fb-meter i{display:block;height:100%;border-radius:999px;background:#d98324}
.fb-status{display:inline-flex;align-items:center;gap:5px;font-size:11px;padding:2px 9px;border-radius:999px;white-space:nowrap}
.fb-status-dot{width:5px;height:5px;border-radius:50%;display:inline-block}
.fb-cap{padding:4px 12px;font-size:10.5px;color:var(--fb-text-4)}
.fb-skel{height:11px;border-radius:5px;background:linear-gradient(90deg,#eef0f3,#f7f8fa,#eef0f3);background-size:200% 100%;animation:fb-sh 1.4s linear infinite}
@keyframes fb-sh{0%{background-position:200% 0}100%{background-position:-200% 0}}
.fb-empty,.fb-error{padding:14px 2px;font-size:12px;color:var(--fb-text-3)}
.fb-error{color:var(--dsw-alias-label-error,#c0392b)}
.fb-foot{margin-top:18px;padding-top:12px;border-top:1px solid var(--fb-line-soft);font-size:10.5px;color:var(--fb-text-4);display:flex;gap:16px;flex-wrap:wrap}
.fb-toast{position:fixed;right:20px;bottom:20px;z-index:40;background:#1f2328;color:#fff;font-size:12px;padding:8px 14px;border-radius:9px;box-shadow:0 8px 24px rgba(16,22,34,.18)}
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
