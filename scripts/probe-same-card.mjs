import { collectBoard } from '../lib/collect.mjs'

const board = await collectBoard()
const needle = '独立评分员'
const rows = board.items.filter((item) => String(item.title).includes(needle))

console.log(`标题含「${needle}」的行：${rows.length}`)
for (const item of rows) {
  console.log(
    [
      item.tool.padEnd(8),
      item.status.padEnd(9),
      new Date(item.lastActivity).toLocaleString('zh-CN'),
      'doing=' + JSON.stringify(item.doing ?? ''),
      'key=' + String(item.key).slice(-46),
    ].join('  '),
  )
}

// Two rows that look identical in every rendered field would read as one card
// drawn twice, even though their keys differ.
const signature = (item) =>
  [item.tool, item.title, item.workspace, item.status, item.lastActivity, item.doing ?? ''].join('|')
const seen = new Map()
for (const item of rows) {
  const key = signature(item)
  seen.set(key, (seen.get(key) ?? 0) + 1)
}
const identical = [...seen.entries()].filter(([, n]) => n > 1)
console.log(
  `\n所有可见字段完全相同（看起来就是同一张卡）的组合：${identical.length}`,
)
for (const [key, n] of identical) console.log(`  ×${n}  ${key}`)
