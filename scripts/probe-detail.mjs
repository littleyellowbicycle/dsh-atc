import { readDshDetail } from '../lib/detail.mjs'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const root = join(homedir(), '.dsh', 'sessions')

// newest session with some tool calls
const candidates = []
for (const ws of readdirSync(root)) {
  for (const entry of readdirSync(join(root, ws), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = join(root, ws, entry.name, 'session.v4.jsonl.zstd')
    try {
      candidates.push({ file, size: statSync(file).size, mtime: statSync(file).mtimeMs })
    } catch {
      /* skip */
    }
  }
}
candidates.sort((a, b) => b.mtime - a.mtime)

for (const candidate of candidates.slice(0, 3)) {
  const started = Date.now()
  const detail = readDshDetail(candidate.file)
  const took = Date.now() - started
  console.log(`\n=== ${candidate.file.replace(root, '~')} ===`)
  console.log(`  ${(candidate.size / 1024 / 1024).toFixed(1)} MB · ${took} ms · 抓到 ${detail.totalCalls} 次调用`)
  console.log('  usage:', JSON.stringify(detail.usage))
  console.log('  lastTurn:', JSON.stringify(detail.lastTurn))
  for (const call of detail.calls.slice(0, 5)) {
    const dur = call.durationMs === null ? '进行中' : `${call.durationMs} ms`
    console.log(`    ${call.name.padEnd(10)} ${String(dur).padStart(8)}  ${call.target.slice(0, 60)}`)
    if (call.snippet) console.log(`      ↳ ${call.snippet.slice(0, 70)}`)
  }
}
