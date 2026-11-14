/**
 * Dry-run probe: print exactly what the board would show, without touching any
 * profile or starting the host. `node scripts/probe.mjs`
 */

import { collectBoard } from '../lib/collect.mjs'

const STATUS_MARK = {
  running: '● running',
  'needs-you': '▲ needs-you',
  failed: '✗ failed',
  stopped: '■ stopped',
  done: '✓ done',
  recent: '· recent',
  idle: '  idle',
}

function ago(ms) {
  if (!ms) return '—'
  const diff = Date.now() - ms
  if (diff < 60_000) return `${Math.max(0, Math.round(diff / 1000))}s ago`
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`
  return `${Math.round(diff / 86_400_000)}d ago`
}

const board = await collectBoard()

console.log('\nsources')
for (const source of board.sources) {
  console.log(
    `  ${source.tool.padEnd(10)} ${
      source.available ? `ok  ${String(source.count ?? 0).padStart(3)} sessions` : `SKIP ${source.reason ?? ''}`
    }`,
  )
}

const bands = { attention: [], running: [], recent: [], older: [] }
const cutoff = Date.now() - 30 * 60_000
for (const item of board.items) {
  if (item.status === 'needs-you' || item.status === 'failed') bands.attention.push(item)
  else if (item.status === 'running') bands.running.push(item)
  else if (item.lastActivity >= cutoff) bands.recent.push(item)
  else bands.older.push(item)
}

console.log(`\n${board.items.length} shown / ${board.total} total · attention=${board.attention} running=${board.running}`)
console.log(
  `bands: 要你处理=${bands.attention.length} 正在跑=${bands.running.length} 最近动过=${bands.recent.length} 更早=${bands.older.length}\n`,
)

const head = ['TOOL', 'STATUS', 'LAST', 'WORKSPACE', 'TITLE', 'DETAIL']
const rows = [...bands.attention, ...bands.running, ...bands.recent].map((item) => [
  item.tool,
  STATUS_MARK[item.status] ?? item.status,
  ago(item.lastActivity),
  item.workspace,
  String(item.title).slice(0, 40),
  item.detail ? String(item.detail).slice(0, 28) : '',
])
const widths = head.map((label, index) =>
  Math.min(46, Math.max(label.length, ...rows.map((row) => String(row[index]).length))),
)
const line = (cells) => cells.map((cell, index) => String(cell).padEnd(widths[index])).join('  ')
console.log(line(head))
console.log(widths.map((width) => '─'.repeat(width)).join('  '))
for (const row of rows) console.log(line(row))
console.log(`\n(+${bands.older.length} older, collapsed by default)\n`)
