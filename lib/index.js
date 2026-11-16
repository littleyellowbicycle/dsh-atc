/**
 * dsh-atc — host half.
 *
 * Serves one same-origin JSON route the browser half polls. All work is local
 * file/SQLite reads: no model calls, no tokens, no network.
 *
 * Discovery is deliberately separate from the poll: walking app directories
 * costs seconds, so it runs once after startup (and on demand), and its result
 * is cached on disk until it goes stale.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { collectBoard } from './collect.mjs'
import { openerLabel, planOpen } from './openers.mjs'
import { spawn } from 'node:child_process'
import { discoverStores, isKnownStore } from './discover.mjs'

/** Plugin manifest name. */
export const name = 'dsh-atc'

/** The route is optional outside Web profiles. */
export const inject = []

/** Absolute route prefix owned by this plugin. */
export const ROUTE = '/dsh-atc'

/** How long a cached discovery stays usable. */
const DISCOVERY_TTL_MS = 6 * 60 * 60 * 1000

/** Bumped whenever the matching rules change, so old caches are discarded. */
const DISCOVERY_SCHEMA = 2

/** Delay before the startup scan, so boot is not competing with a directory walk. */
const DISCOVERY_DELAY_MS = 12_000

/** Set once the connection service is composed; used to fence our route. */
let connection = null

const state = {
  /** Last discovery result, from cache or a live run. */
  result: null,
  /** In-flight run, so two callers cannot walk the disk at once. */
  running: null,
}

function cacheFile() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'atc-discovered.json')
}

function readCache() {
  try {
    const file = cacheFile()
    if (!existsSync(file)) return null
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed.scannedAt !== 'number') return null
    // A cache written by an older matching rule can name stores that a newer
    // rule already reads, which shows up as a duplicate source.
    if (parsed.schema !== DISCOVERY_SCHEMA) return null
    return parsed
  } catch {
    return null
  }
}

function writeCache(result) {
  try {
    const file = cacheFile()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ schema: DISCOVERY_SCHEMA, ...result }, null, 2) + '\n')
  } catch {
    /* a read-only home is not a reason to fail the board */
  }
}

/**
 * Result of the most recent discovery, running one if the cache is missing or
 * stale.
 * @param {boolean} force - ignore the cache and walk again.
 */
async function discovery(force = false) {
  const onDisk = readCache()
  // Another process may have scanned more recently than this one; prefer it.
  const newest =
    onDisk && (!state.result || onDisk.scannedAt > state.result.scannedAt) ? onDisk : state.result ?? onDisk
  const fresh = newest && Date.now() - newest.scannedAt < DISCOVERY_TTL_MS
  if (fresh && !force) {
    state.result = newest
    return newest
  }
  if (state.running) return state.running
  state.running = discoverStores()
    .then((result) => {
      state.result = result
      writeCache(result)
      return result
    })
    .catch(() => newest ?? null)
    .finally(() => {
      state.running = null
    })
  return state.running
}

/**
 * Host/Origin fence plus authenticated-peer check, the same admission the host
 * applies to its own routes. Without it a page in the user's browser could read
 * this endpoint over loopback (DNS rebinding / local CSRF) — the payload names
 * every session on the machine.
 *
 * Returns true when the request may proceed. Hosts that predate the API get a
 * warning and a pass, so the plugin still runs there.
 */
let fenceWarningShown = false
function allowed(request) {
  if (!connection || typeof connection.requestRejection !== 'function') {
    if (!fenceWarningShown) {
      fenceWarningShown = true
      console.warn('dsh-atc: ctx.connection.requestRejection unavailable — /dsh-atc routes are unfenced')
    }
    return true
  }
  try {
    return connection.requestRejection(request) === undefined
  } catch {
    return false
  }
}

/** Read a small JSON body; anything larger is refused rather than buffered. */
async function readJsonBody(request, limit = 8 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) throw new Error(`body too large (> ${limit} bytes)`)
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * Open a terminal running the planned command.
 *
 * The command goes into a temporary .cmd file instead of a command line: cmd's
 * own quoting turned out to be the fragile part (`start "" /min cmd /c "..."`
 * silently produces an empty result, while `start "" <script.cmd>` works). The
 * script also lets the failure case stay readable — if the CLI is missing, the
 * window pauses instead of vanishing.
 *
 * Only Windows is implemented: `start` is the one way to get a visible console
 * from a detached host process, and this plugin is developed and used there.
 * Elsewhere the caller gets "unsupported" and the board copies the path.
 */
function spawnPlan(plan) {
  if (process.platform !== 'win32') return { ok: false, reason: 'unsupported-platform' }
  // Verification seam: proves the route → plan → spawn wiring without opening a
  // real terminal (and without an agent session attached to it).
  if (process.env.DSH_ATC_DRY_OPEN === '1') return { ok: true, dry: true }
  const script = join(tmpdir(), `dsh-atc-open-${Date.now()}.cmd`)
  const body = [
    '@echo off',
    // A cwd that no longer exists would make the script fail before the CLI runs.
    plan.cwd && existsSync(plan.cwd) ? `cd /d "${plan.cwd}"` : '',
    [plan.command, ...plan.args].join(' '),
    // Keep the window open when the command failed, so the error is readable.
    'if errorlevel 1 pause',
  ].filter(Boolean).join('\r\n')
  try {
    writeFileSync(script, body + '\r\n', 'utf8')
    const child = spawn('cmd.exe', ['/c', 'start', '', script], {
      detached: true,
      stdio: 'ignore',
    })
    // spawn reports failure asynchronously; without a listener that becomes an
    // unhandled "error" event and takes the host down.
    child.on('error', () => {})
    child.unref()
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) }
  }
}

function sendJson(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  response.end(payload)
}

/** What the panel shows about discovery: counts only, never the walk itself. */
function discoverySummary() {
  const result = state.result
  if (!result) return { pending: true }
  return {
    scannedAt: result.scannedAt,
    apps: result.apps.length,
    installable: result.installable.length,
    installableNames: result.installable.map((app) => app.app),
  }
}

/** Register the read-only board endpoint. */
export function mountBoardRoute(ctx) {
  return ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE,
    async handler(request, response) {
      if (!allowed(request)) {
        sendJson(response, 403, { error: 'request rejected by the host admission fence' })
        return
      }
      const url = new URL(request.url ?? '/', 'http://local')
      if (url.pathname === `${ROUTE}/discover`) {
        const result = await discovery(url.searchParams.get('refresh') === '1')
        sendJson(response, 200, result ?? { error: 'discovery unavailable' })
        return
      }
      if (url.pathname === `${ROUTE}/open`) {
        if (request.method !== 'POST') {
          sendJson(response, 405, { error: 'POST only' })
          return
        }
        let body
        try {
          body = await readJsonBody(request)
        } catch (error) {
          sendJson(response, 400, { ok: false, reason: String(error?.message ?? error) })
          return
        }
        const plan = planOpen(body)
        if (!plan.ok) {
          // 501: the tool exists but this plugin cannot open it. The client
          // falls back to copying the workspace path.
          sendJson(response, plan.reason === 'no-opener' ? 501 : 400, { ok: false, reason: plan.reason })
          return
        }
        const opened = spawnPlan(plan)
        sendJson(response, opened.ok ? 200 : 501, opened)
        return
      }
      if (url.pathname !== `${ROUTE}/data`) {
        sendJson(response, 404, { error: 'not found' })
        return
      }
      try {
        // Stores discovery matched are read by the generic collector, so a tool
        // the board has no code for still shows up without user action.
        const extra = (state.result?.installable ?? [])
          // A store a hand-written collector already opens must not appear a
          // second time under the directory name it happens to live in.
          .filter((app) => !isKnownStore(app.store))
          .map((app) => ({
            tool: app.app.toLowerCase().replace(/[^a-z0-9]+/g, '') || 'discovered',
            store: app.store,
            specId: app.spec,
          }))
        const board = await collectBoard(extra)
        // Which rows a click can actually open, decided here so the browser does
        // not keep its own copy of the opener table.
        for (const item of board.items) {
          const label = openerLabel(item.tool)
          if (label && item.openId) item.openLabel = label
        }
        board.discovery = discoverySummary()
        sendJson(response, 200, board)
      } catch (error) {
        sendJson(response, 500, { error: String(error?.message ?? error) })
      }
    },
  })
}

/** Cordis plugin body. */
export function apply(ctx) {
  ctx.inject(['connection'], (connCtx) => {
    connection = connCtx.connection
  })

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => mountBoardRoute(webCtx), 'dsh-atc: board route')
    // One background walk per process, well after startup.
    webCtx.effect(() => {
      const timer = setTimeout(() => {
        void discovery()
      }, DISCOVERY_DELAY_MS)
      if (typeof timer.unref === 'function') timer.unref()
      return () => clearTimeout(timer)
    }, 'dsh-atc: startup discovery')
  })
}
