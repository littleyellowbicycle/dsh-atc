/**
 * Discover coding agents installed on this machine and judge whether their
 * session store is readable.
 *
 * Guessing from file names is not enough: opencode keeps its store in
 * `share/opencode/opencode.db`, whose path says nothing about sessions, while a
 * 26 MB `rollout-*.jsonl` may be a model I/O log rather than a conversation.
 * So every candidate is scored by what is inside it, and the best one per app
 * wins.
 *
 * `node scripts/scan-agents.mjs [--json]`
 *
 * Read-only: nothing here writes, moves, or opens a store for writing.
 */

import { existsSync, readdirSync, readFileSync, openSync, readSync, closeSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const home = homedir()
const JSON_OUT = process.argv.includes('--json')
const MAX_APP_DIRS = 400
const MAX_FILES_PER_APP = 24
const SQLITE_MAGIC = 'SQLite format 3'
const SESSION_WORD = /session|chat|conversation|thread|transcript|history|rollout|prompt|message/i

/** Where apps keep data. */
const ROOTS = [
  { path: home, onlyHidden: true },
  { path: join(home, 'AppData', 'Roaming') },
  { path: join(home, 'AppData', 'Local') },
  { path: join(home, 'AppData', 'Local', 'Programs') },
  { path: join(home, '.config') },
]

/** Directory names that never hold a session store but cost a lot to walk. */
const SKIP_DIR =
  /^(node_modules|Cache|Code Cache|GPUCache|Crashpad|logs?|temp|tmp|blob_storage|Service Worker|IndexedDB|Backups?|updates?|installer)$/i

/** Tools the plugin already reads, so the report can say so. */
const KNOWN = new Set(['dsh', 'codex', 'opencode', 'workbuddy', 'gemini', 'zcode', 'minimax', 'claude', 'trae', 'qoder', 'cursor', 'windsurf', 'aider', 'qwen'])

function regularSize(file) {
  try {
    const info = statSync(file)
    return info.isFile() ? info.size : -1
  } catch {
    return -1
  }
}

function headerKind(file) {
  try {
    const buffer = Buffer.alloc(16)
    const fd = openSync(file, 'r')
    try {
      readSync(fd, buffer, 0, 16, 0)
    } finally {
      closeSync(fd)
    }
    return buffer.toString('latin1').startsWith(SQLITE_MAGIC) ? 'sqlite' : 'not-sqlite'
  } catch {
    return 'unreadable'
  }
}

async function sqliteTables(file) {
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      return db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((row) => row.name)
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

/** First few lines of a text store, for judging whether it is a conversation. */
function headLines(file, count = 5) {
  try {
    const size = Math.min(statSync(file).size, 64 * 1024)
    const buffer = Buffer.alloc(size)
    const fd = openSync(file, 'r')
    try {
      readSync(fd, buffer, 0, size, 0)
    } finally {
      closeSync(fd)
    }
    return buffer
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .slice(0, count)
  } catch {
    return []
  }
}

/** Candidate files anywhere under one app directory, shallow and bounded. */
function candidateFiles(dir) {
  const found = []
  const walk = (current, depth) => {
    if (found.length >= MAX_FILES_PER_APP) return
    let entries
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (found.length >= MAX_FILES_PER_APP) return
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        if (depth < 2 && !SKIP_DIR.test(entry.name)) walk(full, depth + 1)
        continue
      }
      if (!/\.(db|sqlite|sqlite3|jsonl)$/i.test(entry.name)) continue
      const size = regularSize(full)
      if (size < 4096) continue
      found.push({ full, size })
    }
  }
  walk(dir, 0)
  return found
}

/** 0-100: how much this file looks like a conversation store. */
async function score(file, size) {
  const kind = /\.(db|sqlite|sqlite3)$/i.test(file) ? headerKind(file) : 'text'
  if (kind === 'not-sqlite' || kind === 'unreadable') {
    // A binary that is not SQLite is worth naming (usually encrypted) but not
    // worth pretending it is readable.
    return { score: SESSION_WORD.test(file) ? 5 : 0, kind: 'encrypted?', shape: 'opaque container', tables: [] }
  }
  if (kind === 'sqlite') {
    const tables = await sqliteTables(file)
    if (tables === null) {
      // A running app can hold its store; that is not evidence of encryption.
      // Above a jsonl log (60): a store the running app holds is still the real store.
      return { score: 65, kind: 'sqlite', shape: 'locked by a running app — close it and rescan', tables: [] }
    }
    const hasSession = tables.some((name) => /^sessions?$/i.test(name) || /_sessions?$/i.test(name) || /^thread/i.test(name))
    const hasMessage = tables.some((name) => /messages?$/i.test(name) || /_messages?$/i.test(name) || /^thread_items$/i.test(name))
    const hinted = tables.some((name) => SESSION_WORD.test(name))
    const value = hasSession && hasMessage ? 100 : hasSession ? 75 : hinted ? 55 : 12
    const shape = hasSession && hasMessage ? 'readable: session + message' : hasSession ? 'session table only' : hinted ? 'session-ish tables' : 'no session tables'
    return { score: value, kind: 'sqlite', shape, tables: tables.slice(0, 8) }
  }
  // Text: judge by what the first lines look like.
  const lines = headLines(file)
  const looksConversation = lines.some((line) => /"role"\s*:/.test(line) || /"session_?id"\s*:/i.test(line))
  const looksRollout = /rollout/i.test(file) && !looksConversation
  return {
    score: looksConversation ? 60 : looksRollout ? 8 : SESSION_WORD.test(file) ? 25 : 5,
    kind: 'text',
    shape: looksConversation ? 'jsonl with role/session fields' : looksRollout ? 'raw model I/O log' : 'other text',
    tables: [],
  }
}

async function main() {
  const apps = []
  let scannedDirs = 0
  const seen = new Set()
  for (const root of ROOTS) {
    if (!existsSync(root.path)) continue
    let entries
    try {
      entries = readdirSync(root.path, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || scannedDirs >= MAX_APP_DIRS) continue
      if (SKIP_DIR.test(entry.name)) continue
      if (root.onlyHidden && !entry.name.startsWith('.')) continue
      if (!root.onlyHidden && entry.name.startsWith('.')) continue
      const dir = join(root.path, entry.name)
      if (seen.has(dir)) continue
      seen.add(dir)
      scannedDirs += 1
      const files = candidateFiles(dir)
      if (files.length === 0) continue
      let best = null
      for (const file of files) {
        const verdict = await score(file.full, file.size)
        if (!best || verdict.score > best.score) best = { ...verdict, ...file }
      }
      if (!best || best.score < 25) continue
      apps.push({ app: entry.name, dir, ...best })
    }
  }

  apps.sort((a, b) => b.score - a.score)
  if (JSON_OUT) {
    console.log(JSON.stringify({ scannedDirs, apps }, null, 2))
    return
  }
  console.log(`scanned ${scannedDirs} app directories · ${apps.length} with conversation-shaped data\n`)
  for (const app of apps) {
    const known = KNOWN.has(app.app.toLowerCase().replace(/[^a-z]/g, '')) ? ' [已接入]' : ''
    console.log(`${app.app}${known}   score ${app.score}`)
    console.log(`   store : ${app.full.replace(home, '~')}  (${Math.round(app.size / 1024)} kB)`)
    console.log(`   kind  : ${app.kind} · ${app.shape}`)
    if (app.tables.length) console.log(`   tables: ${app.tables.join(', ')}`)
  }
  console.log(`
怎么读：
  100  score  → session + message 都在，给我 40 行就能接
   75  score  → 只有会话表，可能只存元数据
   55  score  → 表名像会话，值得打开看一眼
   60  score  → jsonl 里带 role/session 字段，可以按行读
    5  score  → 文件头不是 SQLite，多半加密，接不了
`)
}

await main()
