import { collectBoard } from '../lib/collect.mjs'

const board = await collectBoard()
const rows = board.items

/* Three ways one session could look like two rows:
 *   a) same key under two different tool labels  → two collectors read one store
 *   b) same title + same activity minute          → the same row emitted twice
 *   c) same title, different days                 → genuinely different sessions
 */
const group = (keyOf) => {
  const map = new Map()
  for (const item of rows) {
    const key = keyOf(item)
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(item)
  }
  return [...map.entries()].filter(([, list]) => list.length > 1)
}

const sameKeyDifferentTool = group((item) => item.key).filter(
  ([, list]) => new Set(list.map((item) => item.tool)).size > 1,
)
console.log(`a) 同一个 key 出现在不同 tool 下：${sameKeyDifferentTool.length} 组`)
for (const [key, list] of sameKeyDifferentTool.slice(0, 5)) {
  console.log(`   ${String(key).slice(-50)}`)
  for (const item of list) console.log(`      tool=${item.tool} status=${item.status}`)
}

const sameMinute = group((item) => `${item.tool}|${item.title}|${Math.round(item.lastActivity / 60000)}`)
console.log(`\nb) 同 tool + 同标题 + 同一分钟内：${sameMinute.length} 组`)
for (const [key, list] of sameMinute.slice(0, 5)) {
  console.log(`   ${key}`)
  for (const item of list) console.log(`      key=${String(item.key).slice(-46)} status=${item.status}`)
}

const sameTitle = group((item) => `${item.tool}|${item.title}`)
console.log(`\nc) 同 tool + 同标题（可能是不同天的同类任务）：${sameTitle.length} 组`)
for (const [key, list] of sameTitle.slice(0, 6)) {
  const spans = list.map((item) => new Date(item.lastActivity).toLocaleDateString('zh-CN'))
  console.log(`   ${key.slice(0, 50)} ×${list.length}  ${[...new Set(spans)].join(' / ')}`)
}
