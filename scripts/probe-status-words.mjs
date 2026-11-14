import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'

const home = homedir()

/* WorkBuddy: what its own status column actually says */
try {
  const db = new DatabaseSync(join(home, '.workbuddy', 'workbuddy.db'), { readOnly: true })
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM sessions GROUP BY status ORDER BY n DESC').all()
  console.log('workbuddy.sessions.status:', rows.map((r) => `${r.status}=${r.n}`).join('  '))
  db.close()
} catch (error) {
  console.log('workbuddy: unreadable', error.message)
}

/* MiniMax: same question */
try {
  const db = new DatabaseSync(join(home, '.minimax', 'v2', 'sqlite', 'runtime-state.sqlite'), { readOnly: true })
  const rows = db
    .prepare('SELECT status, COUNT(*) AS n FROM local_runtime_sessions GROUP BY status ORDER BY n DESC')
    .all()
  console.log('minimax.status          :', rows.map((r) => `${r.status}=${r.n}`).join('  '))
  db.close()
} catch (error) {
  console.log('minimax: unreadable', error.message)
}

/* DSH: the reason each turn ended, over the sessions the board reads */
const { readdirSync, openSync, readSync, closeSync, statSync } = await import('node:fs')
const { zstdDecompressSync } = await import('node:zlib')
const root = join(home, '.dsh', 'sessions')
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const tally = {}

function lastEvents(file) {
  const size = statSync(file).size
  const len = Math.min(size, 64 * 1024)
  const buf = Buffer.alloc(len)
  const fd = openSync(file, 'r')
  try {
    readSync(fd, buf, 0, len, size - len)
  } finally {
    closeSync(fd)
  }
  const offsets = []
  let i = 0
  while ((i = buf.indexOf(magic, i)) !== -1) {
    offsets.push(i)
    i += 4
  }
  for (let k = offsets.length - 1; k >= 1; k -= 1) {
    try {
      const events = zstdDecompressSync(buf.subarray(offsets[k]))
        .toString('utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
      if (events.length) return events
    } catch {
      /* truncated frame */
    }
  }
  return []
}

for (const ws of readdirSync(root)) {
  for (const entry of readdirSync(join(root, ws), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    try {
      const events = lastEvents(join(root, ws, entry.name, 'session.v4.jsonl.zstd'))
      const last = events[events.length - 1]
      const key = last?.type === 'turn/end' ? `turn/end:${last.data?.reason?.kind}` : last?.type
      tally[key] = (tally[key] || 0) + 1
    } catch {
      /* skip */
    }
  }
}
console.log('dsh last event         :', Object.entries(tally).map(([k, v]) => `${k}=${v}`).join('  '))
