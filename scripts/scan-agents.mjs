/**
 * CLI over the discovery engine: `node scripts/scan-agents.mjs [--json]`.
 *
 * The same code runs inside the plugin at startup; this wrapper exists so a
 * person can look without opening the panel.
 */

import { discoverStores } from '../lib/discover.mjs'

const asJson = process.argv.includes('--json')
const result = await discoverStores(20_000)

if (asJson) {
  console.log(JSON.stringify(result, null, 2))
} else {
  console.log(
    `scanned ${result.scannedDirs} app directories in ${result.tookMs} ms · ${result.apps.length} with conversation-shaped data\n`,
  )
  for (const app of result.apps) {
    console.log(`${app.app}${app.known ? ' [已接入]' : ''}   score ${app.score}`)
    console.log(`   store : ${app.store.replace(process.env.USERPROFILE ?? '', '~')}  (${app.sizeKb} kB)`)
    console.log(`   kind  : ${app.kind} · ${app.shape}`)
    if (app.spec) console.log(`   spec  : ${app.spec}  → 通用采集器可直接读`)
    if (app.tables.length) console.log(`   tables: ${app.tables.join(', ')}`)
  }
  if (result.installable.length > 0) {
    console.log(`\n可接入但还没接：${result.installable.map((app) => app.app).join('、')}`)
  }
  console.log(`
怎么读：
  100 + spec  → 形状已知，给我 40 行就能接（或已接）
   75         → 有会话表但没有对应 spec，值得打开看一眼
   65         → 应用正在运行锁住了库，关掉再扫
    5         → 文件头不是 SQLite，多半加密
`)
}
