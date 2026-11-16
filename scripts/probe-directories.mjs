/**
 * Which directories opencode / codex were started in, from their own stores.
 * `node scripts/probe-directories.mjs [tool]`
 */

import { DatabaseSync } from 'node:sqlite'
import { existsSync, openSync, readSync, closeSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const want = (process.argv[2] ?? 'both').toLowerCase()
const DAY = 86_400_000
const now = Date.now()
const ago = (ms) => {
  if (!ms) return '-'
  const diff = now - ms
  if (diff < 0) return new Date(ms).toLocaleString('zh-CN')
  if (diff < 60 * 60_000) return Math.round(diff / 60_000) + ' 分钟前'
  if (diff < DAY) return Math.round(diff / 3_600_000) + ' 小时前'
  return Math.round(diff / DAY) + ' 天前'
}

function opencodeDirs() {
  const file = join(homedir(), '.local', 'share', 'opencode', 'opencode.db')
  if (!existsSync(file)) return { rows: [], note: 'no opencode.db' }
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name)
    const hasWorkspace = tables.includes('workspace')
    const rows = db
      .prepare(
        `SELECT directory AS dir, COUNT(*) AS n, MAX(time_updated) AS last
           FROM session WHERE directory IS NOT NULL AND directory <> ''
          GROUP BY directory ORDER BY last DESC`,
      )
      .all()
    const workspaces = hasWorkspace
      ? db.prepare('SELECT * FROM workspace').all()
      : []
    return { rows, workspaces, total: db.prepare('SELECT COUNT(*) AS n FROM session').get()?.n }
  } finally {
    db.close()
  }
}

function codexDirs() {
  const root = join(homedir(), '.codex', 'sessions')
  if (!existsSync(root)) return { rows: [], note: 'no ~/.codex/sessions' }
  const files = []
  const walk = (dir, depth) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < 5) walk(full, depth + 1)
      } else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
        try {
          files.push({ full, mtime: statSync(full).mtimeMs })
        } catch {
          /* skip */
        }
      }
    }
  }
  walk(root, 0)

  const byDir = new Map()
  for (const { full, mtime } of files) {
    const fd = openSync(full, 'r')
    let head = ''
    try {
      const buffer = Buffer.alloc(64 * 1024)
      readSync(fd, buffer, 0, buffer.length, 0)
      head = buffer.toString('utf8')
    } finally {
      closeSync(fd)
    }
    const cwd = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head)?.[1]
    const key = cwd ? cwd.replace(/\\\\/g, '\\') : '(无法读取 cwd)'
    const slot = byDir.get(key) ?? { dir: key, n: 0, last: 0 }
    slot.n += 1
    slot.last = Math.max(slot.last, mtime)
    byDir.set(key, slot)
  }
  return { rows: [...byDir.values()].sort((a, b) => b.last - a.last), total: files.length }
}

const show = (label, data) => {
  console.log(`\n=== ${label} ===`)
  if (data.note) {
    console.log('  ' + data.note)
    return
  }
  if (data.total !== undefined) console.log(`  共 ${data.total} 条会话`)
  if (data.rows.length === 0) {
    console.log('  （没有记录）')
    return
  }
  const width = Math.min(70, Math.max(...data.rows.map((r) => String(r.dir).length)))
  for (const row of data.rows) {
    console.log(`  ${String(row.n).padStart(3)} 条  ${ago(row.last).padEnd(10)}  ${String(row.dir).slice(0, width)}`)
  }
  if (data.workspaces?.length) {
    console.log('\n  workspace 表：')
    for (const w of data.workspaces) console.log('    ' + JSON.stringify(w).slice(0, 160))
  }
}

if (want === 'both' || want === 'opencode') show('opencode：启动目录', opencodeDirs())
if (want === 'both' || want === 'codex') show('codex：启动目录', codexDirs())
