import { collectBoard } from '../lib/collect.mjs'

const board = await collectBoard()
const sig = (item, withDay) =>
  [item.tool, item.title, item.workspace, withDay ? new Date(item.lastActivity).toDateString() : ''].join('|')

for (const withDay of [false, true]) {
  const counts = new Map()
  for (const item of board.items) counts.set(sig(item, withDay), (counts.get(sig(item, withDay)) ?? 0) + 1)
  const marked = board.items.filter((item) => (counts.get(sig(item, withDay)) ?? 0) >= 2)
  const groups = new Set(marked.map((item) => sig(item, withDay))).size
  console.log(
    `${withDay ? '同一天内才算冲突' : '任意日期同名都算冲突'}: ${marked.length} 行 / ${groups} 组 / 共 ${board.items.length} 行`,
  )
}

// 具体的冲突组（跨天 vs 当天）
const withDay = new Map()
for (const item of board.items) {
  const key = sig(item, true)
  if (!withDay.has(key)) withDay.set(key, [])
  withDay.get(key).push(item)
}
console.log('\n同一天内的冲突组：')
for (const [key, list] of [...withDay.entries()].filter(([, l]) => l.length > 1).slice(0, 8)) {
  const [tool, title, workspace, day] = key.split('|')
  console.log(`  ${day}  ${tool}  ${title.slice(0, 26)}  ×${list.length}`)
}
