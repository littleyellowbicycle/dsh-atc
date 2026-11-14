import { collectBoard } from '../lib/collect.mjs'

const board = await collectBoard()
const now = Date.now()
const older = board.items.filter(
  (item) => !(item.status === 'needs-you' || item.status === 'failed' || item.status === 'running') && now - item.lastActivity >= 30 * 60_000,
)
console.log('older band:', older.length)
for (const days of [1, 2, 3, 7]) {
  const n = older.filter((item) => now - item.lastActivity < days * 86_400_000).length
  console.log(`  近 ${days} 天: ${n} 条`)
}
