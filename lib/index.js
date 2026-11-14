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
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { collectBoard } from './collect.mjs'
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
      const url = new URL(request.url ?? '/', 'http://local')
      if (url.pathname === `${ROUTE}/discover`) {
        const result = await discovery(url.searchParams.get('refresh') === '1')
        sendJson(response, 200, result ?? { error: 'discovery unavailable' })
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
