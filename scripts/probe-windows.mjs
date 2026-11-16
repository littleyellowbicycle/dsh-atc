/**
 * What the board can and cannot bring to the front on this machine.
 *
 * Run it while the tools you care about are open — that is the only moment the
 * answer is meaningful. `node scripts/probe-windows.mjs`
 */

import { listWindows, focusWindow, WINDOW_MATCHERS } from '../lib/focus.mjs'

const windows = listWindows()
console.log(`=== 可见窗口（${windows.length}）===`)
for (const w of windows) console.log(`  ${String(w.proc).padEnd(18)} ${String(w.pid).padEnd(7)} ${w.title}`)

console.log('\n=== 各工具的匹配结果 ===')
for (const [tool, criteria] of Object.entries(WINDOW_MATCHERS)) {
  const matches = windows.filter((w) => {
    const titleOk = !criteria.title || new RegExp(criteria.title, 'i').test(w.title)
    const procOk = !criteria.proc || new RegExp(criteria.proc).test(w.proc)
    return titleOk && procOk
  })
  const label = matches.length === 0 ? '（没有窗口，点击会退回开新终端/复制路径）' : matches.map((m) => `「${m.title}」`).join(' ')
  console.log(`  ${tool.padEnd(10)} ${String(matches.length).padStart(2)} 个  ${label}`)
}

console.log('\n=== 把 WorkBuddy 切到前台（并重新读取前台窗口验证）===')
console.log(' ', JSON.stringify(focusWindow({ proc: '^WorkBuddy$' })))
