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
import { zstdDecompressSync } from 'node:zlib'

/** Defaults; override any key with `$DSH_HOME/atc.json`. */
export const DEFAULTS = {
  perSource: 40,
  runningSeconds: 120,
  recentMinutes: 30,
  attentionHours: 24,
}

/** Memo for the tunables file, which is small but read on every poll. */
const tunablesMemo = { mtime: 0, value: DEFAULTS }

const DAY = 24 * 60 * 60 * 1000

/** DSH_HOME honours the host's own env override. */
export function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

/**
 * The tunables file, newest name first. `fleet-board.json` is the pre-rename
 * name and is still honoured so existing setups keep working.
 */
function tunablesFile() {
  const home = dshHome()
  for (const name of ['atc.json', 'fleet-board.json']) {
    const file = join(home, name)
    if (existsSync(file)) return file
  }
  return join(home, 'atc.json')
}

/**
 * Current tunables. Re-read only when the file's mtime moves, so editing
 * `$DSH_HOME/atc.json` needs no restart.
 * @returns the merged configuration.
 */
export function tunables() {
  try {
    const file = tunablesFile()
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

/**
 * Agents this board looks for, whether or not it can read them.
 *
 * Detection is path/PATH based and independent of parsing: a tool found here
 * but without a parser is still reported, as "detected, not connected", so the
 * board never pretends the list of sources is complete.
 */
export const AGENT_CATALOG = [
  { tool: 'dsh', parsed: true, paths: [() => join(dshHome(), 'sessions')] },
  { tool: 'codex', parsed: true, paths: [() => join(homedir(), '.codex', 'sessions')] },
  { tool: 'opencode', parsed: true, paths: [() => join(homedir(), '.local', 'share', 'opencode')] },
  { tool: 'workbuddy', parsed: true, paths: [() => join(homedir(), '.workbuddy')] },
  { tool: 'gemini', parsed: true, paths: [() => join(homedir(), '.gemini', 'tmp')] },
  { tool: 'claude', parsed: true, paths: [() => join(homedir(), '.claude', 'projects')] },
  { tool: 'zcode', parsed: true, paths: [() => join(homedir(), '.zcode')] },
  { tool: 'minimax', parsed: true, paths: [() => join(homedir(), '.minimax'), () => join(homedir(), '.mavis')] },
  {
    tool: 'qoder',
    parsed: false,
    reason: '未检测到安装',
    paths: [() => join(homedir(), '.qoder'), () => join(homedir(), 'AppData', 'Roaming', 'Qoder')],
  },
  {
    tool: 'trae',
    parsed: true,
    paths: [() => join(homedir(), '.trae', 'cli', 'sessions')],
  },
  {
    tool: 'trae',
    parsed: false,
    reason: '会话存在加密数据库里，明文读不到',
    paths: [
      () => join(homedir(), '.trae-cn'),
      () => join(homedir(), 'AppData', 'Roaming', 'Trae CN'),
    ],
  },
  { tool: 'cursor', parsed: false, reason: '尚未支持', paths: [() => join(homedir(), '.cursor'), () => join(homedir(), 'AppData', 'Roaming', 'Cursor')] },
  { tool: 'windsurf', parsed: false, reason: '尚未支持', paths: [() => join(homedir(), '.windsurf'), () => join(homedir(), '.codeium')] },
  { tool: 'aider', parsed: false, reason: '尚未支持', paths: [() => join(homedir(), '.aider')] },
  { tool: 'qwen', parsed: false, reason: '尚未支持', paths: [() => join(homedir(), '.qwen')] },
]

/**
 * What exists on this machine, and whether the board can read it.
 * @returns `{ agents: [{ tool, parsed, path }] }`.
 */
export function detectAgents() {
  const agents = []
  for (const entry of AGENT_CATALOG) {
    for (const resolve of entry.paths) {
      let found = ''
      try {
        const candidate = resolve()
        if (existsSync(candidate)) found = candidate
      } catch {
        /* an unresolvable candidate is simply absent */
      }
      if (found) {
        agents.push({ tool: entry.tool, parsed: entry.parsed, path: found, reason: entry.reason ?? '' })
        break
      }
    }
  }
  return agents
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

/**
 * A session log is a sequence of independent zstd frames, one per appended
 * batch of events. The whole-file decoder stops after the first frame, but each
 * frame decodes on its own — which is enough to read the `session/title` event
 * (near the head) and the last `turn/start` / `turn/end` (near the tail).
 *
 * Two bounded windows are read and the answer is memoised per mtime, so a poll
 * costs one stat per session and a decode only when a session moves.
 */
const logMemo = new Map()
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const HEAD_WINDOW = 512 * 1024
const TAIL_WINDOW = 96 * 1024

/** Byte offsets of every zstd frame in a window. */
function frameOffsets(buffer) {
  const offsets = []
  let cursor = 0
  while (true) {
    const at = buffer.indexOf(ZSTD_MAGIC, cursor)
    if (at === -1) break
    offsets.push(at)
    cursor = at + 4
  }
  return offsets
}

/** Decode one frame's events, or nothing when the slice is truncated. */
function eventsOfFrame(buffer, at) {
  let text
  try {
    text = zstdDecompressSync(buffer.subarray(at)).toString('utf8')
  } catch {
    return []
  }
  const events = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      /* a half-written line is not an event */
    }
  }
  return events
}

function readWindow(file, size, from, length) {
  const buffer = Buffer.alloc(length)
  const fd = openSync(file, 'r')
  try {
    readSync(fd, buffer, 0, length, from)
  } finally {
    closeSync(fd)
  }
  return buffer
}

/**
 * What the session log says about a DSH session: its title, and the boundaries
 * of its last turn.
 * @returns `{ title, lastStart, lastEnd }` where `lastEnd` is `{ time, reason }`.
 */
function readDshLog(file) {
  let info
  try {
    info = statSync(file)
  } catch {
    return { title: '', lastStart: 0, lastEnd: null }
  }
  const memo = logMemo.get(file)
  if (memo && memo.mtime === info.mtimeMs) return memo.value

  let title = ''
  let lastStart = 0
  let lastEnd = null
  try {
    const headLength = Math.min(info.size, HEAD_WINDOW)
    const head = readWindow(file, info.size, 0, headLength)
    const headFrames = frameOffsets(head)
    // A session gets two titles: a truncated first prompt (fallback) and then
    // the model-written one. Keep the fallback, but prefer the provider's.
    for (const at of headFrames.slice(0, 40)) {
      let done = false
      for (const event of eventsOfFrame(head, at)) {
        if (event?.type !== 'session/title') continue
        const value = event.data?.title
        if (typeof value !== 'string' || value.trim() === '') continue
        title = value.trim()
        if (event.data?.source?.kind === 'provider') done = true
      }
      if (done) break
    }

    // A small log fits entirely in the head window; a big one needs its tail.
    const tail =
      headLength === info.size
        ? head
        : readWindow(file, info.size, info.size - Math.min(info.size, TAIL_WINDOW), Math.min(info.size, TAIL_WINDOW))
    const tailFrames = frameOffsets(tail)
    // Walk backwards from the newest frame and stop once the last turn is known:
    // no need to decode a whole 96 kB window of history.
    let scanned = 0
    for (let index = tailFrames.length - 1; index >= 1 && scanned < 24; index -= 1, scanned += 1) {
      for (const event of eventsOfFrame(tail, tailFrames[index])) {
        if (event?.type === 'turn/start' && typeof event.time === 'number') {
          lastStart = Math.max(lastStart, event.time)
        }
        if (event?.type === 'turn/end' && typeof event.time === 'number') {
          if (!lastEnd || event.time > lastEnd.time) {
            lastEnd = { time: event.time, reason: String(event.data?.reason?.kind ?? '') }
          }
        }
      }
      if (lastEnd && (!lastStart || lastStart > lastEnd.time)) break
    }
  } catch {
    /* unreadable log means no title and no turn facts, not a failed session */
  }

  const value = { title, lastStart, lastEnd }
  logMemo.set(file, { mtime: info.mtimeMs, value })
  return value
}

/**
 * Status from the session's own turn boundaries, falling back to age.
 *
 * A turn that started and has not ended is the only honest "running". A turn
 * that ended with a reason we understand outranks age; a plain completion means
 * "quiet now", so it decays instead of claiming to be running.
 * @returns one of running | needs-you | failed | stopped | recent | idle.
 */
export function statusFromTurn(turn, lastMs, now, conf = DEFAULTS) {
  const open = turn.lastStart > 0 && (!turn.lastEnd || turn.lastStart > turn.lastEnd.time)
  if (open) return 'running'
  if (turn.lastEnd) {
    const reason = turn.lastEnd.reason.toLowerCase()
    if (/approv|block|wait|confirm|pending/.test(reason)) return 'needs-you'
    if (/error|fail/.test(reason)) return 'failed'
    if (/abort|cancel|interrupt|stop|kill/.test(reason)) return 'stopped'
    const age = now - (turn.lastEnd.time || lastMs)
    return age < conf.recentMinutes * 60_000 ? 'recent' : 'idle'
  }
  return inferStatus(lastMs, '', now, conf)
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
      const logFile = join(full, 'session.v4.jsonl.zstd')
      const log = readDshLog(logFile)
      rows.push({
        tool: 'dsh',
        workspace: knownWorkspaces.get(id) ?? workspaceLabel(decodeDshWorkspace(workspace.name)),
        title: log.title || `未命名 · ${id.slice(0, 4)}`,
        detail: '',
        // Full id the host's sessions service accepts for navigation.
        sessionId: session.name.startsWith('session-') ? session.name : `session-${session.name}`,
        lastActivity: mtime,
        status: statusFromTurn(log, mtime, now, conf),
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
        if (now - mtime > 90 * DAY) continue
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
      // The first real ask sits behind developer instructions and an
      // environment preamble, so 4 kB is not enough of the log.
      head = readHead(full, 256 * 1024)
    } catch {
      continue
    }
    const cwd = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head)?.[1]
    const provider = /"model_provider"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head)?.[1]
    const sessionId = /"session_id"\s*:\s*"([^"]+)"/.exec(head)?.[1]

    // codex logs the environment and skills as synthetic user messages; the
    // first one that is neither is the prompt this session is about.
    let prompt = ''
    const memo = textMemo.get(full)
    if (memo && memo.mtime === mtime) {
      prompt = memo.prompt
    } else {
      for (const line of head.split('\n')) {
        if (!line.includes('"role":"user"')) continue
        try {
          const record = JSON.parse(line)
          const payload = record?.payload
          if (payload?.type !== 'message' || payload.role !== 'user') continue
          const text = (Array.isArray(payload.content) ? payload.content : [])
            .map((part) => part?.text ?? '')
            .join(' ')
          const clean = cleanPrompt(text)
          if (clean === '' || isSyntheticPrompt(text)) continue
          prompt = text
          break
        } catch {
          /* a line cut off by the head limit is not a prompt */
        }
      }
      textMemo.set(full, { mtime, prompt })
    }

    rows.push({
      tool: 'codex',
      workspace: workspaceLabel(cwd?.replace(/\\\\/g, '\\')),
      title: titleFromPrompt(prompt) || (sessionId ? sessionId.slice(0, 8) : full.slice(-20, -6)),
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
                (SELECT COUNT(*) FROM todo WHERE session_id = s.id AND status != 'completed') AS open_todos,
                (SELECT json_extract(p.data, '$.text')
                   FROM part p JOIN message pm ON pm.id = p.message_id
                  WHERE pm.session_id = s.id
                    AND json_extract(pm.data, '$.role') = 'user'
                    AND json_extract(p.data, '$.type') = 'text'
                  ORDER BY pm.time_created, p.time_created LIMIT 1) AS first_text
           FROM session s LEFT JOIN message m ON m.session_id = s.id
          GROUP BY s.id ORDER BY t DESC LIMIT ?`,
      )
      .all(conf.perSource)
    const total = db.prepare('SELECT COUNT(*) AS n FROM session').get()?.n ?? rows.length
    const items = rows.map((row) => {
      const last = toMs(row.t)
      const open = Number(row.open_todos) || 0
      const all = Number(row.todos) || 0
      // opencode names a fresh session "New session - <timestamp>"; that is a
      // placeholder, not a name, so prefer the first thing the user asked.
      const declared = String(row.title ?? '')
      const placeholder = declared === '' || /^new session\b/i.test(declared)
      const prompt = String(row.first_text ?? '').replace(/\s+/g, ' ').trim()
      const title = placeholder
        ? prompt
          ? `${prompt.slice(0, 40)}${prompt.length > 40 ? '…' : ''}`
          : declared || String(row.id).slice(0, 8)
        : declared
      return {
        tool: 'opencode',
        workspace: workspaceLabel(row.dir),
        title,
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
 * Gemini CLI keeps one JSON file per chat under
 * `~/.gemini/tmp/<project>/chats/session-*.json`, with the original project
 * path in the sibling `.project_root`.
 */
/** Memo for derived titles of formats that need a parse (gemini, codex). */
const textMemo = new Map()

/** Strip the machine-instruction preamble agents inject ahead of the real ask. */
function cleanPrompt(text) {
  let value = String(text ?? '').replace(/\r/g, '')
  // Gemini puts its rules in a leading [..] block; markdown headings are noise.
  value = value.replace(/^\s*\[[^\]]*\]\s*/i, '')
  value = value.replace(/^\s*#{1,6}\s*/, '')
  value = value.replace(/\s+/g, ' ').trim()
  return value
}

/** Shorten a prompt into a title, or '' when there is nothing usable. */
function titleFromPrompt(text, limit = 40) {
  const clean = cleanPrompt(text)
  if (clean === '') return ''
  return `${clean.slice(0, limit)}${clean.length > limit ? '…' : ''}`
}

/** Whether a log line is machine instruction rather than something a person asked. */
function isSyntheticPrompt(text) {
  const value = String(text ?? '').trimStart()
  return (
    value.startsWith('<') ||
    /^#?\s*AGENTS\.md instructions/i.test(value) ||
    /^#?\s*AGENTS\.md\b/i.test(value) ||
    /^(environment_context|skills_instructions|user_instructions)/i.test(value)
  )
}

function collectGemini(now, conf) {
  const root = join(homedir(), '.gemini', 'tmp')
  if (!existsSync(root)) return { tool: 'gemini', available: false, reason: 'no ~/.gemini/tmp' }
  const rows = []
  let projects
  try {
    projects = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  } catch (error) {
    return { tool: 'gemini', available: false, reason: String(error?.message ?? error) }
  }
  for (const project of projects) {
    const base = join(root, project.name)
    let projectRoot = ''
    try {
      projectRoot = readFileSync(join(base, '.project_root'), 'utf8').trim()
    } catch {
      /* older layouts keep no project marker */
    }
    let chats
    try {
      chats = readdirSync(join(base, 'chats'), { withFileTypes: true }).filter(
        (entry) => entry.isFile() && entry.name.endsWith('.json'),
      )
    } catch {
      continue
    }
    for (const chat of chats) {
      const full = join(base, 'chats', chat.name)
      let mtime = 0
      try {
        mtime = statSync(full).mtimeMs
      } catch {
        continue
      }
      // The chat file has no title field, so use the first thing that was asked.
      let prompt = ''
      const memo = textMemo.get(full)
      if (memo && memo.mtime === mtime) {
        prompt = memo.prompt
      } else {
        try {
          const chatData = JSON.parse(readFileSync(full, 'utf8'))
          const messages = Array.isArray(chatData?.messages) ? chatData.messages : []
          const first = messages.find((message) => message?.type === 'user')
          const parts = Array.isArray(first?.content) ? first.content : []
          prompt = parts.map((part) => part?.text ?? '').join(' ')
        } catch {
          /* an unreadable chat still gets a time-based label */
        }
        textMemo.set(full, { mtime, prompt })
      }
      rows.push({
        tool: 'gemini',
        workspace: workspaceLabel(projectRoot) || project.name,
        title: titleFromPrompt(prompt) || chat.name.replace(/^session-/, '').replace(/\.json$/, '').slice(0, 16),
        detail: '',
        lastActivity: mtime,
        status: inferStatus(mtime, '', now, conf),
        key: full,
      })
    }
  }
  rows.sort((a, b) => b.lastActivity - a.lastActivity)
  return {
    tool: 'gemini',
    available: true,
    count: rows.length,
    items: rows.slice(0, conf.perSource),
  }
}

/**
 * ZCode keeps an opencode-shaped SQLite store: `session` (title, directory)
 * joined with `message` for the last activity time.
 */
async function collectZcode(now, conf) {
  const path = join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite')
  if (!existsSync(path)) return { tool: 'zcode', available: false, reason: 'no ~/.zcode/cli/db' }
  let db
  try {
    db = await openSqlite(path)
    const rows = db
      .prepare(
        `SELECT s.id AS id, s.title AS title, s.directory AS dir, MAX(m.time_updated) AS t
           FROM session s LEFT JOIN message m ON m.session_id = s.id
          GROUP BY s.id ORDER BY t DESC LIMIT ?`,
      )
      .all(conf.perSource)
    const total = db.prepare('SELECT COUNT(*) AS n FROM session').get()?.n ?? rows.length
    const items = rows.map((row) => {
      const last = toMs(row.t)
      return {
        tool: 'zcode',
        workspace: workspaceLabel(row.dir),
        title: row.title || String(row.id).slice(0, 12),
        detail: '',
        lastActivity: last,
        status: inferStatus(last, '', now, conf),
        key: row.id,
      }
    })
    return { tool: 'zcode', available: true, count: Number(total), items }
  } catch (error) {
    return { tool: 'zcode', available: false, reason: String(error?.message ?? error) }
  } finally {
    try {
      db?.close()
    } catch {
      /* already gone */
    }
  }
}

/**
 * MiniMax Code (and its Mavis runtime) record sessions in a local SQLite state
 * store; the row keeps both a status column and a JSON record with the
 * workspace directory.
 */
async function collectMinimax(now, conf) {
  const candidates = [
    join(homedir(), '.minimax', 'v2', 'sqlite', 'runtime-state.sqlite'),
    join(homedir(), '.mavis', 'v2', 'sqlite', 'runtime-state.sqlite'),
  ]
  const path = candidates.find((candidate) => existsSync(candidate))
  if (!path) return { tool: 'minimax', available: false, reason: 'no minimax runtime state' }
  let db
  try {
    db = await openSqlite(path)
    const rows = db
      .prepare(
        `SELECT session_id AS id, agent_name AS agent, status AS status,
                updated_at_ms AS t, record_json AS record,
                (SELECT json_extract(m.data_json, '$.msg_content')
                   FROM local_runtime_message_rows m
                  WHERE m.session_id = s.session_id AND m.role = 'user'
                  ORDER BY m.created_at_ms LIMIT 1) AS first_prompt
           FROM local_runtime_sessions s
          WHERE archived = 0
          ORDER BY updated_at_ms DESC LIMIT ?`,
      )
      .all(conf.perSource)
    const total =
      db.prepare('SELECT COUNT(*) AS n FROM local_runtime_sessions WHERE archived = 0').get()?.n ??
      rows.length
    const items = rows.map((row) => {
      const last = toMs(row.t)
      const record = String(row.record ?? '')
      const workspace = /"workspaceDir"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(record)?.[1]
      // Newer records dropped the title field, so the first prompt it is —
      // the same fallback DSH itself uses before the model names a session.
      const recorded = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(record)?.[1]
      const prompt = String(row.first_prompt ?? '').replace(/\s+/g, ' ').trim()
      const title = recorded || (prompt ? `${prompt.slice(0, 40)}${prompt.length > 40 ? '…' : ''}` : '')
      return {
        tool: 'minimax',
        workspace: workspaceLabel(workspace?.replace(/\\\\/g, '\\')),
        title: title || `${row.agent ?? 'minimax'} · ${String(row.id).slice(-8)}`,
        detail: row.agent ? String(row.agent) : '',
        lastActivity: last,
        status: inferStatus(last, row.status, now, conf),
        key: row.id,
      }
    })
    return { tool: 'minimax', available: true, count: Number(total), items }
  } catch (error) {
    return { tool: 'minimax', available: false, reason: String(error?.message ?? error) }
  } finally {
    try {
      db?.close()
    } catch {
      /* already gone */
    }
  }
}

/**
 * Claude Code keeps one JSONL per session under
 * `~/.claude/projects/<slug>/<session-id>.jsonl`; the head carries `cwd`,
 * `sessionId` and a timestamp. Machines without that directory simply report
 * zero sessions rather than an error.
 */
function collectClaude(now, conf) {
  const root = join(homedir(), '.claude', 'projects')
  if (!existsSync(root)) return { tool: 'claude', available: false, reason: 'no ~/.claude/projects' }
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
        if (depth < 3) walk(full, depth + 1)
      } else if (entry.name.endsWith('.jsonl')) {
        let mtime = 0
        try {
          mtime = statSync(full).mtimeMs
        } catch {
          continue
        }
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
    const summary = /"summary"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(head)?.[1]
    rows.push({
      tool: 'claude',
      workspace: workspaceLabel(cwd?.replace(/\\\\/g, '\\')),
      title: summary || full.split(/[\\/]/).pop().replace(/\.jsonl$/, '').slice(0, 8),
      detail: '',
      lastActivity: mtime,
      status: inferStatus(mtime, '', now, conf),
      key: full,
    })
  }
  return { tool: 'claude', available: true, count: found.length, items: rows }
}

/**
 * TRAE CLI (2.0, `traex`) writes plaintext rollouts under
 * `~/.trae/cli/sessions/YYYY/MM/DD/rollout-*.jsonl`, shaped like codex's.
 * NOTE: unverified against a real installation — the IDE's own store is an
 * encrypted SQLCipher database, so this only fires for the CLI.
 */
function collectTraeCli(now, conf) {
  const root = join(homedir(), '.trae', 'cli', 'sessions')
  if (!existsSync(root)) return { tool: 'trae', available: false, reason: 'no ~/.trae/cli/sessions' }
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
      } else if (entry.name.endsWith('.jsonl')) {
        let mtime = 0
        try {
          mtime = statSync(full).mtimeMs
        } catch {
          continue
        }
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
    const id = /"session_id"\s*:\s*"([^"]+)"/.exec(head)?.[1]
    rows.push({
      tool: 'trae',
      workspace: workspaceLabel(cwd?.replace(/\\\\/g, '\\')),
      title: id ? id.slice(0, 8) : full.slice(-20, -6),
      detail: 'cli',
      lastActivity: mtime,
      status: inferStatus(mtime, '', now, conf),
      key: full,
    })
  }
  return { tool: 'trae', available: true, count: found.length, items: rows }
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
    Promise.resolve()
      .then(() => collectGemini(now, conf))
      .catch((error) => ({ tool: 'gemini', available: false, reason: String(error?.message ?? error) })),
    Promise.resolve()
      .then(() => collectZcode(now, conf))
      .catch((error) => ({ tool: 'zcode', available: false, reason: String(error?.message ?? error) })),
    Promise.resolve()
      .then(() => collectMinimax(now, conf))
      .catch((error) => ({ tool: 'minimax', available: false, reason: String(error?.message ?? error) })),
    Promise.resolve()
      .then(() => collectClaude(now, conf))
      .catch((error) => ({ tool: 'claude', available: false, reason: String(error?.message ?? error) })),
    Promise.resolve()
      .then(() => collectTraeCli(now, conf))
      .catch((error) => ({ tool: 'trae', available: false, reason: String(error?.message ?? error) })),
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
    // Everything found on this machine, including tools without a parser, so
    // the board can say what it is not showing.
    agents: detectAgents(),
  }
}
