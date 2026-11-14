/**
 * Fleet collectors: read every local agent's session store and normalize one
 * row per active session. Pure local I/O — no model calls, no tokens spent.
 *
 * Sources:
 *   dsh       ~/.dsh/sessions/<workspace>/*\/session.v4.jsonl.zstd   (mtime + path)
 *   codex     ~/.codex/sessions/**\/rollout-*.jsonl                  (head: cwd, model_provider)
 *   opencode  ~/.local/share/opencode/opencode.db                    (sqlite: session + message + todo)
 *   workbuddy ~/.workbuddy/workbuddy.db                              (sqlite: sessions + session_usage)
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Defaults; override any key with `$DSH_HOME/fleet-board.json`. */
export const DEFAULTS = {
  perSource: 40,
  runningSeconds: 120,
  recentMinutes: 30,
  attentionHours: 24,
}

/** Memo for the tunables file, which is small but read on every poll. */
const tunablesMemo = { mtime: 0, value: DEFAULTS }

const DAY = 24 * 60 * 60 * 1000

/** Memo for the cost ledger: 2.3 MB, so parse it only when its mtime moves. */
const ledgerMemo = { mtime: 0, spend: null }

/** DSH_HOME honours the host's own env override. */
export function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/**
 * Current tunables. Re-read only when the file's mtime moves, so editing
 * `$DSH_HOME/fleet-board.json` needs no restart.
 * @returns the merged configuration.
 */
export function tunables() {
  try {
    const file = join(dshHome(), 'fleet-board.json')
    if (!existsSync(file)) return DEFAULTS
    const mtime = statSync(file).mtimeMs
    if (tunablesMemo.mtime === mtime) return tunablesMemo.value
    const merged = { ...DEFAULTS, ...JSON.parse(readFileSync(file, 'utf8')) }
    tunablesMemo.mtime = mtime
    tunablesMemo.value = merged
    return merged
  } catch {
    return DEFAULTS
  }
}

/** Normalize epoch-seconds, epoch-ms, or an ISO string to epoch-ms. */
export function toMs(value) {
  if (value === null || value === undefined) return 0
  if (typeof value === 'number') return value > 1e12 ? value : value * 1000
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Infer a coarse state from the store's own status plus how recently the
 * session moved. Deliberately conservative: anything that looks like a
 * request for the human outranks recency.
 * @param lastMs - last activity in epoch-ms.
 * @param rawStatus - the store's own status string, when it has one.
 * @param now - current epoch-ms.
 * @param conf - tunables (running window, recent window).
 * @returns one of running | needs-you | failed | stopped | done | recent | idle.
 */
export function inferStatus(lastMs, rawStatus, now, conf = DEFAULTS) {
  const raw = String(rawStatus ?? '').toLowerCase()
  if (/wait|pending|ask|confirm|approv|input|blocked/.test(raw)) return 'needs-you'
  if (/fail|error/.test(raw)) return 'failed'
  if (/terminat|cancel|stop|kill|abort/.test(raw)) return 'stopped'
  if (/done|complete|finish|success|archived/.test(raw)) return 'done'
  if (/run|active|progress|working|busy/.test(raw)) return 'running'
  const age = now - lastMs
  if (age < conf.runningSeconds * 1000) return 'running'
  if (age < conf.recentMinutes * 60_000) return 'recent'
  return 'idle'
}

/** Which ledger field and symbol belong to a currency. */
const CURRENCY = {
  CNY: ['costCny', '¥'],
  USD: ['cost', '$'],
  EUR: ['costEur', '€'],
}

/**
 * Today's DSH spend from the cost-meter ledger (that plugin records per day,
 * keyed by local date, split by `provider:model`). Only DSH's own usage is in
 * here — codex/opencode/WorkBuddy have no comparable ledger.
 * @returns `{ cost, symbol, currency, calls, byProvider }` or null.
 */
function readDshSpend() {
  try {
    const file = join(dshHome(), 'storages', 'cost-meter', 'ledger.json')
    if (!existsSync(file)) return null
    const mtime = statSync(file).mtimeMs
    if (ledgerMemo.spend !== null && ledgerMemo.mtime === mtime) return ledgerMemo.spend
    const ledger = JSON.parse(readFileSync(file, 'utf8'))
    const now = new Date()
    const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const record = ledger?.days?.[key]
    if (!record) {
      ledgerMemo.mtime = mtime
      ledgerMemo.spend = null
      return null
    }
    const currency = ledger?.config?.currency ?? 'CNY'
    const [field, fallbackSymbol] = CURRENCY[currency] ?? ['cost', '$']
    const amount = typeof record[field] === 'number' ? record[field] : record.cost
    const byProvider = Object.entries(record.byProviderModel ?? {}).map(([name, value]) => ({
      name,
      cost: typeof value?.[field] === 'number' ? value[field] : value?.cost ?? 0,
    }))
    const spend = {
      cost: amount,
      symbol: ledger?.config?.symbol || fallbackSymbol,
      currency,
      calls: record.calls ?? 0,
      byProvider,
    }
    ledgerMemo.mtime = mtime
    ledgerMemo.spend = spend
    return spend
  } catch {
    return null
  }
}

/** A path fragment that reads well in a narrow column. */
function workspaceLabel(path) {
  if (!path) return '—'
  const parts = String(path).split(/[\\/]+/).filter(Boolean)
  return parts.slice(-2).join('\\') || String(path)
}

/** DSH encodes a workspace path into a session directory name. */
function decodeDshWorkspace(name) {
  const inner = name.replace(/^--/, '').replace(/--$/, '')
  // The encoding is lossy (`-` is both separator and literal), so this is only
  // a fallback for sessions the workspace store does not know about.
  return inner.replace(/-/g, ' ')
}

/**
 * Authoritative session → workspace map from DSH's own workspace store.
 * @returns a Map keyed by the session id with the `session-` prefix removed.
 */
function readDshWorkspaces() {
  const map = new Map()
  const file = join(dshHome(), 'storages', 'workspace.json')
  if (!existsSync(file)) return map
  try {
    const store = JSON.parse(readFileSync(file, 'utf8'))
    const workspaces = store?.tables?.workspaces ?? {}
    for (const record of Object.values(workspaces)) {
      const label = record?.title || workspaceLabel(record?.path)
      for (const sessionId of record?.sessionIds ?? []) {
        map.set(String(sessionId).replace(/^session-/, ''), label)
      }
    }
  } catch {
    /* a corrupt store falls back to the encoded directory name */
  }
  return map
}

/** Newest mtime inside one directory tree, bounded. */
function newestMtime(dir, depth = 0) {
  let best = 0
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return best
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    try {
      if (entry.isDirectory()) {
        if (depth < 2) best = Math.max(best, newestMtime(full, depth + 1))
      } else {
        best = Math.max(best, statSync(full).mtimeMs)
      }
    } catch {
      /* a file vanishing mid-scan is not an error */
    }
  }
  return best
}

function collectDsh(now, conf) {
  const root = join(dshHome(), 'sessions')
  if (!existsSync(root)) return { tool: 'dsh', available: false, reason: 'no ~/.dsh/sessions' }
  const rows = []
  const knownWorkspaces = readDshWorkspaces()
  for (const workspace of readdirSync(root, { withFileTypes: true })) {
    if (!workspace.isDirectory()) continue
    const wsPath = join(root, workspace.name)
    let sessions
    try {
      sessions = readdirSync(wsPath, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    } catch {
      continue
    }
    for (const session of sessions) {
      const full = join(wsPath, session.name)
      const mtime = newestMtime(full)
      if (!mtime) continue
      const id = session.name.replace(/^session-/, '')
      rows.push({
        tool: 'dsh',
        workspace: knownWorkspaces.get(id) ?? workspaceLabel(decodeDshWorkspace(workspace.name)),
        title: id.slice(0, 8),
        detail: '',
        // Full id the host's sessions service accepts for navigation.
        sessionId: session.name.startsWith('session-') ? session.name : `session-${session.name}`,
        lastActivity: mtime,
        status: inferStatus(mtime, '', now, conf),
        key: full,
      })
    }
  }
  rows.sort((a, b) => b.lastActivity - a.lastActivity)
  return { tool: 'dsh', available: true, count: rows.length, items: rows.slice(0, conf.perSource) }
}

/** Read the first bytes of a file without loading the whole thing. */
function readHead(path, bytes = 4096) {
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(bytes)
    readSync(fd, buffer, 0, bytes, 0)
    return buffer.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

function collectCodex(now, conf) {
  const root = join(homedir(), '.codex', 'sessions')
  if (!existsSync(root)) return { tool: 'codex', available: false, reason: 'no ~/.codex/sessions' }
  const found = []
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
        if (depth < 4) walk(full, depth + 1)
      } else if (entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
        let mtime = 0
        try {
          mtime = statSync(full).mtimeMs
        } catch {
          continue
        }
        if (now - mtime > 30 * DAY) continue
        found.push({ full, mtime })
      }
    }
  }
  walk(root, 0)
  found.sort((a, b) => b.mtime - a.mtime)
  const rows = []
  for (const { full, mtime } of found.slice(0, conf.perSource)) {
    let head = ''
    try {
      head = readHead(full)
    } catch {
      continue
    }
    const cwd = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head)?.[1]
    const provider = /"model_provider"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head)?.[1]
    const sessionId = /"session_id"\s*:\s*"([^"]+)"/.exec(head)?.[1]
    rows.push({
      tool: 'codex',
      workspace: workspaceLabel(cwd?.replace(/\\\\/g, '\\')),
      title: sessionId ? sessionId.slice(0, 8) : full.slice(-20, -6),
      detail: provider ?? '',
      lastActivity: mtime,
      status: inferStatus(mtime, '', now, conf),
      key: full,
    })
  }
  return { tool: 'codex', available: true, count: found.length, items: rows }
}

/** Open one SQLite file read-only through the built-in driver. */
async function openSqlite(path) {
  const { DatabaseSync } = await import('node:sqlite')
  try {
    return new DatabaseSync(path, { readOnly: true })
  } catch {
    return new DatabaseSync(path)
  }
}

async function collectOpencode(now, conf) {
  const path = join(homedir(), '.local', 'share', 'opencode', 'opencode.db')
  if (!existsSync(path)) return { tool: 'opencode', available: false, reason: 'no opencode.db' }
  let db
  try {
    db = await openSqlite(path)
    const rows = db
      .prepare(
        `SELECT s.id AS id, s.directory AS dir, s.title AS title, MAX(m.time_updated) AS t,
                (SELECT COUNT(*) FROM todo WHERE session_id = s.id) AS todos,
                (SELECT COUNT(*) FROM todo WHERE session_id = s.id AND status != 'completed') AS open_todos
           FROM session s LEFT JOIN message m ON m.session_id = s.id
          GROUP BY s.id ORDER BY t DESC LIMIT ?`,
      )
      .all(conf.perSource)
    const total = db.prepare('SELECT COUNT(*) AS n FROM session').get()?.n ?? rows.length
    const items = rows.map((row) => {
      const last = toMs(row.t)
      const open = Number(row.open_todos) || 0
      const all = Number(row.todos) || 0
      return {
        tool: 'opencode',
        workspace: workspaceLabel(row.dir),
        title: row.title || String(row.id).slice(0, 8),
        detail: open > 0 ? `todo ${open}/${all}` : '',
        lastActivity: last,
        status: inferStatus(last, '', now, conf),
        key: row.id,
      }
    })
    return { tool: 'opencode', available: true, count: Number(total), items }
  } catch (error) {
    return { tool: 'opencode', available: false, reason: String(error?.message ?? error) }
  } finally {
    try {
      db?.close()
    } catch {
      /* already gone */
    }
  }
}

/** Context pressure and credits from WorkBuddy's own usage table, when present. */
function usageDetail(row) {
  const parts = []
  const used = Number(row.used)
  const size = Number(row.size)
  if (Number.isFinite(used) && Number.isFinite(size) && size > 0) {
    parts.push(`ctx ${Math.round((used / size) * 100)}%`)
  }
  if (row.credit_json) {
    try {
      const credits = Object.values(JSON.parse(row.credit_json)).filter((value) => typeof value === 'number')
      if (credits.length > 0) {
        parts.push(`${credits.reduce((sum, value) => sum + value, 0).toFixed(1)} 点`)
      }
    } catch {
      /* a malformed credit blob is not worth failing the row */
    }
  }
  return parts.join(' · ')
}

async function collectWorkbuddy(now, conf) {
  const path = join(homedir(), '.workbuddy', 'workbuddy.db')
  if (!existsSync(path)) return { tool: 'workbuddy', available: false, reason: 'no workbuddy.db' }
  let db
  try {
    db = await openSqlite(path)
    const rows = db
      .prepare(
        `SELECT s.id AS id, s.cwd AS cwd, s.title AS title, s.status AS status,
                s.last_activity_at AS last_activity_at, s.updated_at AS updated_at,
                u.used AS used, u.size AS size, u.credit_json AS credit_json
           FROM sessions s LEFT JOIN session_usage u ON u.session_id = s.id
          WHERE s.deleted_at IS NULL
          ORDER BY COALESCE(s.last_activity_at, s.updated_at) DESC LIMIT ?`,
      )
      .all(conf.perSource)
    const total = db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE deleted_at IS NULL').get()?.n ?? rows.length
    const items = rows.map((row) => {
      const last = toMs(row.last_activity_at) || toMs(row.updated_at)
      return {
        tool: 'workbuddy',
        workspace: workspaceLabel(row.cwd),
        title: row.title || String(row.id).slice(0, 8),
        detail: usageDetail(row),
        lastActivity: last,
        status: inferStatus(last, row.status, now, conf),
        key: row.id,
      }
    })
    return { tool: 'workbuddy', available: true, count: Number(total), items }
  } catch (error) {
    return { tool: 'workbuddy', available: false, reason: String(error?.message ?? error) }
  } finally {
    try {
      db?.close()
    } catch {
      /* already gone */
    }
  }
}

/**
 * Collect every available source. A failing source degrades to
 * `available: false` instead of failing the whole board.
 * @returns the normalized board payload.
 */
export async function collectBoard() {
  const now = Date.now()
  const conf = tunables()
  const sources = await Promise.all([
    Promise.resolve()
      .then(() => collectDsh(now, conf))
      .catch((error) => ({ tool: 'dsh', available: false, reason: String(error?.message ?? error) })),
    Promise.resolve()
      .then(() => collectCodex(now, conf))
      .catch((error) => ({ tool: 'codex', available: false, reason: String(error?.message ?? error) })),
    collectOpencode(now, conf),
    collectWorkbuddy(now, conf),
  ])
  const items = sources.flatMap((source) => source.items ?? [])
  items.sort((a, b) => b.lastActivity - a.lastActivity)
  // Old failures are history, not attention: only recent ones earn a slot.
  const failedWindow = conf.attentionHours * 60 * 60 * 1000
  const attention = items.filter(
    (item) =>
      item.status === 'needs-you' || (item.status === 'failed' && now - item.lastActivity <= failedWindow),
  )
  return {
    generatedAt: now,
    sources: sources.map(({ items: _items, ...rest }) => rest),
    items,
    attention: attention.length,
    running: items.filter((item) => item.status === 'running').length,
    total: sources.reduce((sum, source) => sum + (Number(source.count) || 0), 0),
    spend: readDshSpend(),
  }
}
