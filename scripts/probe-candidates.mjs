import { discoverStores, isKnownStore } from '../lib/discover.mjs'
import { matchSpec } from '../lib/sources.mjs'
import { DatabaseSync } from 'node:sqlite'

const result = await discoverStores(20_000)
console.log(`扫描 ${result.scannedDirs} 个目录 · ${result.apps.length} 个像会话库\n`)

const auto = []
const candidates = []
const unreadable = []

for (const app of result.apps) {
  const known = isKnownStore(app.store)
  const row = { app: app.app, store: app.store.replace(process.env.USERPROFILE, '~'), spec: app.spec, score: app.score }
  if (app.spec && !known) auto.push(row)
  else if (!app.spec && !known && app.kind === 'sqlite') candidates.push(row)
  else if (!known) unreadable.push(row)
}

const show = (title, list, extra) => {
  console.log(`${title}: ${list.length}`)
  for (const row of list) console.log(`   ${row.app.padEnd(14)} score=${String(row.score).padEnd(3)} ${row.store}${extra ? extra(row) : ''}`)
  console.log('')
}

show('① 已自动接入（形状对上 spec，且没有手写采集器）', auto)
show('② 候选：有会话表但对不上任何 spec（现在完全看不见）', candidates)
show('③ 其他（锁库 / 无会话表）', unreadable)

console.log('=== 候选库的表结构 ===')
for (const row of candidates) {
  const path = row.store.replace('~', process.env.USERPROFILE)
  try {
    const db = new DatabaseSync(path, { readOnly: true })
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
    const interesting = tables.filter((name) => /session|thread|conversation|message|chat/i.test(name))
    console.log(`\n${row.app}: ${interesting.join(', ') || '(无可疑表)'}`)
    for (const table of interesting.slice(0, 3)) {
      const cols = db.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name)
      const count = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get()?.n
      console.log(`   ${table} (${count} 行): ${cols.join(', ')}`)
    }
    db.close()
  } catch (error) {
    console.log(`\n${row.app}: 打不开 — ${error.message}`)
  }
}

console.log('\n=== 现有 spec ===')
for (const spec of ['opencode-like', 'runtime-state', 'workbuddy-like', 'thread-history']) {
  console.log('  ' + spec)
}
console.log('\nmatchSpec 现在认的表组合决定了上面 ② 里的库为什么进不来。')
