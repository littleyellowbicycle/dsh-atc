/**
 * Discovery: find agent session stores on this machine and say what they are.
 *
 * Two different jobs, two different costs:
 *   - the board itself reads a fixed list of known paths every few seconds; that
 *     must stay cheap and deterministic;
 *   - discovery walks application directories, opens candidate databases and
 *     scores them. It is seconds of I/O, so it runs once at startup (and on
 *     demand), never inside a poll.
 *
 * Results are matched against `SOURCE_SPECS`, so "discovered" means "a spec
 * already knows this shape", which is exactly what makes it installable.
 */

import { existsSync, readdirSync, openSync, readSync, closeSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { matchSpec } from './sources.mjs'

const home = homedir()
const SQLITE_MAGIC = 'SQLite format 3'
const MAX_APP_DIRS = 400
const MAX_FILES_PER_APP = 24
const SESSION_WORD = /session|chat|conversation|thread|transcript|history|rollout|prompt|message/i

/** Where applications keep their data. */
function roots() {
  return [
    { path: home, onlyHidden: true },
    { path: join(home, 'AppData', 'Roaming') },
    { path: join(home, 'AppData', 'Local') },
    { path: join(home, 'AppData', 'Local', 'Programs') },
    { path: join(home, '.config') },
  ]
}

/** Directory names that never hold a session store but cost a lot to walk. */
const SKIP_DIR =
  /^(node_modules|Cache|Code Cache|GPUCache|Crashpad|logs?|temp|tmp|blob_storage|Service Worker|IndexedDB|Backups?|updates?|installer)$/i

/** Store paths the board's collectors already open. */
const KNOWN_STORE = /([\\/]\.?(dsh|codex|zcode|minimax|mavis|workbuddy|gemini|claude|trae)[\\/]|opencode\.db|workbuddy\.db|runtime-state\.sqlite|thread_history)/i

/** Tools the board already reads. */
const KNOWN = new Set([
  'dsh',
  'codex',
  'opencode',
  'workbuddy',
  'gemini',
  'zcode',
  'minimax',
  'claude',
  'trae',
  'qoder',
  'cursor',
  'windsurf',
  'aider',
  'qwen',
])

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

/** Column names of one table, or null when it cannot be read. */
async function sqliteColumns(file, table) {
  try {
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      return db
        .prepare(`PRAGMA table_info("${table}")`)
        .all()
        .map((row) => row.name)
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

/** Whether a matched spec's identity and time columns are actually present. */
async function specFits(file, matched) {
  const columns = await sqliteColumns(file, matched.resolved.sessionTable)
  if (!columns) return false
  const has = (candidates) => candidates.some((name) => columns.includes(name))
  return has(matched.resolved.columns.id) && has(matched.resolved.columns.updated)
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
    return buffer.toString('utf8').split('\n').filter(Boolean).slice(0, count)
  } catch {
    return []
  }
}

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
export async function scoreStore(file) {
  const size = regularSize(file)
  if (size < 0) return { score: 0, kind: 'missing', shape: ' vanished', spec: null, tables: [] }
  const kind = /\.(db|sqlite|sqlite3)$/i.test(file) ? headerKind(file) : 'text'
  if (kind === 'not-sqlite' || kind === 'unreadable') {
    return {
      score: SESSION_WORD.test(file) ? 5 : 0,
      kind: 'encrypted?',
      shape: 'opaque container (not SQLite)',
      spec: null,
      tables: [],
    }
  }
  if (kind === 'sqlite') {
    const tables = await sqliteTables(file)
    if (tables === null) {
      return {
        score: 65,
        kind: 'sqlite',
        shape: 'locked by a running app — close it and rescan',
        spec: null,
        tables: [],
      }
    }
    let matched = matchSpec(tables)
    if (matched && !(await specFits(file, matched))) matched = null
    const hasSession = tables.some((name) => /^sessions?$/i.test(name) || /_sessions?$/i.test(name) || /^thread/i.test(name))
    const hinted = tables.some((name) => SESSION_WORD.test(name))
    return {
      score: matched ? 100 : hasSession ? 75 : hinted ? 55 : 12,
      kind: 'sqlite',
      shape: matched
        ? `matches spec: ${matched.spec.id}`
        : hasSession
          ? 'session table only, no spec'
          : hinted
            ? 'session-ish tables, no spec'
            : 'no session tables',
      spec: matched?.spec.id ?? null,
      tables: tables.slice(0, 8),
    }
  }
  const lines = headLines(file)
  const looksConversation = lines.some((line) => /"role"\s*:/.test(line) || /"session_?id"\s*:/i.test(line))
  const looksRollout = /rollout/i.test(file) && !looksConversation
  return {
    score: looksConversation ? 60 : looksRollout ? 8 : SESSION_WORD.test(file) ? 25 : 5,
    kind: 'text',
    shape: looksConversation ? 'jsonl with role/session fields' : looksRollout ? 'raw model I/O log' : 'other text',
    spec: null,
    tables: [],
  }
}

/** Whether a store path is one the board already reads. */
export function isKnownStore(store) {
  return KNOWN_STORE.test(String(store ?? ''))
}

/**
 * Walk the machine and describe every store that looks like conversations.
 * @param {number} [budgetMs] - stop early once this much time has passed.
 * @returns discovered applications, best store first.
 */
export async function discoverStores(budgetMs = 8000) {
  const startedAt = Date.now()
  const apps = []
  const seen = new Set()
  let scannedDirs = 0
  let truncated = false

  for (const root of roots()) {
    if (truncated) break
    if (!existsSync(root.path)) continue
    let entries
    try {
      entries = readdirSync(root.path, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (Date.now() - startedAt > budgetMs) {
        truncated = true
        break
      }
      if (!entry.isDirectory() || scannedDirs >= MAX_APP_DIRS) continue
      if (SKIP_DIR.test(entry.name)) continue
      // Home only contributes dot-directories; AppData only contributes plain ones.
      if ((root.onlyHidden === true) !== entry.name.startsWith('.')) continue
      const dir = join(root.path, entry.name)
      if (seen.has(dir)) continue
      seen.add(dir)
      scannedDirs += 1
      const files = candidateFiles(dir)
      if (files.length === 0) continue
      let best = null
      for (const file of files) {
        const verdict = await scoreStore(file.full)
        if (!best || verdict.score > best.score) best = { ...verdict, ...file }
      }
      if (!best || best.score < 25) continue
      const store = best.full
      const alreadyRead =
        KNOWN.has(entry.name.toLowerCase().replace(/[^a-z]/g, '')) || KNOWN_STORE.test(store)
      apps.push({
        app: entry.name,
        known: alreadyRead,
        dir,
        store,
        sizeKb: Math.round(best.size / 1024),
        score: best.score,
        kind: best.kind,
        shape: best.shape,
        spec: best.spec,
        tables: best.tables,
      })
    }
  }

  apps.sort((a, b) => b.score - a.score)
  return {
    scannedAt: Date.now(),
    tookMs: Date.now() - startedAt,
    scannedDirs,
    truncated,
    apps,
    /** Stores a spec already understands but the board does not read yet. */
    installable: apps.filter((app) => app.spec && !app.known),
  }
}
