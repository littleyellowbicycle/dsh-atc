/**
 * Read a store that discovery matched but the board has no hand-written
 * collector for.
 *
 * The spec already says which table is the session list and which column names
 * are acceptable for id / title / workspace / status / updated, so one query
 * per store is enough — no per-tool code. Everything is read-only, and a store
 * that does not actually expose the identity and time columns is skipped rather
 * than guessed at.
 */

import { SOURCE_SPECS } from './sources.mjs'

/** Concrete column names of one table. */
async function tableColumns(db, table) {
  try {
    return db
      .prepare(`PRAGMA table_info("${table}")`)
      .all()
      .map((row) => row.name)
  } catch {
    return []
  }
}

function firstPresent(candidates, columns) {
  for (const candidate of candidates ?? []) {
    if (columns.includes(candidate)) return candidate
  }
  return null
}

/**
 * Collect rows from one discovered store.
 * @param {object} db - open read-only database handle.
 * @param {{ tool: string, store: string, specId: string }} entry - matching discovery row.
 * @param {object} conf - tunables (perSource).
 * @param {number} now - current epoch-ms.
 * @param {(ms: number, raw: string, now: number, conf: object) => string} inferStatus
 * @returns `{ tool, available, count, items }`
 */
export async function collectDiscovered(db, entry, conf, now, inferStatus) {
  const spec = SOURCE_SPECS.find((candidate) => candidate.id === entry.specId)
  if (!spec) return { tool: entry.tool, available: false, reason: 'spec vanished' }

  const sessionTable = spec.sessionTables.find((table) => table)
  const columns = await tableColumns(db, sessionTable)
  if (columns.length === 0) return { tool: entry.tool, available: false, reason: 'no session table' }

  const idColumn = firstPresent(spec.columns.id, columns)
  const updatedColumn = firstPresent(spec.columns.updated, columns)
  // Without identity and time there is no honest row to draw.
  if (!idColumn || !updatedColumn) {
    return { tool: entry.tool, available: false, reason: 'missing id/updated columns' }
  }
  const titleColumn = firstPresent(spec.columns.title, columns)
  const workspaceColumn = firstPresent(spec.columns.workspace, columns)
  const statusColumn = firstPresent(spec.columns.status, columns)

  const select = [
    `"${idColumn}" AS id`,
    titleColumn ? `"${titleColumn}" AS title` : `NULL AS title`,
    workspaceColumn ? `"${workspaceColumn}" AS workspace` : `NULL AS workspace`,
    statusColumn ? `"${statusColumn}" AS state` : `NULL AS state`,
    `"${updatedColumn}" AS updated`,
  ].join(', ')

  let rows
  try {
    rows = db
      .prepare(
        `SELECT ${select} FROM "${sessionTable}" ORDER BY "${updatedColumn}" DESC LIMIT ?`,
      )
      .all(conf.perSource)
  } catch (error) {
    return { tool: entry.tool, available: false, reason: String(error?.message ?? error) }
  }
  if (rows.length === 0) return { tool: entry.tool, available: false, reason: 'no rows' }

  const items = rows.map((row) => {
    const last = Number(row.updated) > 1e12 ? Number(row.updated) : Number(row.updated) * 1000
    const title = typeof row.title === 'string' && row.title.trim() !== '' ? row.title.trim() : ''
    return {
      tool: entry.tool,
      auto: true,
      workspace: typeof row.workspace === 'string' ? row.workspace : '',
      title: title || String(row.id).slice(0, 8),
      detail: '自动发现',
      lastActivity: Number.isFinite(last) ? last : 0,
      status: inferStatus(Number.isFinite(last) ? last : 0, row.state ?? '', now, conf),
      key: `${entry.store}:${row.id}`,
    }
  })
  return { tool: entry.tool, available: true, count: items.length, items, auto: true }
}

/** Every spec id a store could have matched, for diagnostics. */
export function specIds() {
  return SOURCE_SPECS.map((spec) => spec.id)
}
