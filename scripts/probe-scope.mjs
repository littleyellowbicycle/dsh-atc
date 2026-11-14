import { collectBoard } from '../lib/collect.mjs'

const board = await collectBoard()
const now = Date.now()
const DAY = 86_400_000

function tally(items) {
  const counts = {}
  for (const item of items) counts[item.tool] = (counts[item.tool] || 0) + 1
  return Object.entries(counts).sort((a, b) => b[1] - a[1])
}

function show(label, items) {
  const rows = tally(items)
  console.log(`${label.padEnd(10)} ${String(items.length).padStart(3)} 条 · ${rows.map(([k, v]) => `${k} ${v}`).join(' · ')}`)
}

show('活跃', board.items.filter((i) => ['needs-you', 'failed', 'running', 'recent'].includes(i.status)))
show('近 24h', board.items.filter((i) => now - i.lastActivity < DAY))
show('近 7 天', board.items.filter((i) => now - i.lastActivity < 7 * DAY))
show('近 30 天', board.items.filter((i) => now - i.lastActivity < 30 * DAY))
show('全部', board.items)
