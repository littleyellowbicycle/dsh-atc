/**
 * IO capabilities: how to get records out of a store, without knowing what a
 * session is.
 *
 * A capability answers exactly one question — "give me rows" — and knows nothing
 * about titles, statuses or workspace labels. That separation is what lets four
 * stores with four different schemas share one read path while each keeps its
 * own query: the query is the store's shape, the read is the same every time.
 *
 * Deliberately not a spec-driven mini-ORM. Lifting the per-store SQL into
 * declarative data would need joins, subqueries, side tables and filters to be
 * expressible, and the four stores disagree on every one of those — the result
 * would be a query builder with four callers, which is worse than four readable
 * queries. See `lib/sources.mjs` for the declarative layer that *is* worth it:
 * deciding whether an unknown store is readable at all.
 */

import { existsSync } from 'node:fs'

/** Open one SQLite file read-only through the built-in driver. */
export async function openSqlite(path) {
  const { DatabaseSync } = await import('node:sqlite')
  try {
    return new DatabaseSync(path, { readOnly: true })
  } catch {
    // Pre-existing fallback, kept as-is by this refactor: some stores refuse a
    // read-only open (locking), and the board would rather read them than skip
    // them. It is the one place this plugin opens a database writable, which is
    // why the README's "always readOnly" wording needs fixing separately.
    return new DatabaseSync(path)
  }
}

/**
 * Read one SQLite-backed store.
 *
 * The four hand-written SQLite collectors had ~25 lines of identical scaffold
 * each — file check, open, query, count, close, and a catch that reports the
 * failure as one unavailable source. That scaffold is what this function is: the
 * only parts each store keeps are its path, its two queries and its row mapper.
 *
 * @param tool - source id, also the `tool` on every row.
 * @param candidates - database paths, first existing one wins.
 * @param missing - why the source is unavailable when no candidate exists.
 * @param now - current epoch-ms, passed through to `map`.
 * @param conf - tunables; `perSource` caps the rows.
 * @param countSql - one-row query returning the store's total as `n`.
 * @param rowSql - the row query; its last `?` is `conf.perSource`.
 * @param map - row → board item. Receives `{ now, conf }` as the second argument.
 */
export async function readSqliteSource({ tool, candidates, missing, now, conf, countSql, rowSql, map }) {
  const path = candidates.find((candidate) => existsSync(candidate))
  if (!path) return { tool, available: false, reason: missing }
  let db
  try {
    db = await openSqlite(path)
    const rows = db.prepare(rowSql).all(conf.perSource)
    const total = db.prepare(countSql).get()?.n ?? rows.length
    const items = rows.map((row) => map(row, { now, conf }))
    return { tool, available: true, count: Number(total), items }
  } catch (error) {
    return { tool, available: false, reason: String(error?.message ?? error) }
  } finally {
    try {
      db?.close()
    } catch {
      /* already gone */
    }
  }
}
