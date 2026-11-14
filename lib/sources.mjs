/**
 * Declarative source specs: what a session store looks like, expressed as data.
 *
 * Hand-writing one collector per agent means every new tool is code. A spec
 * instead says "a session table with these columns, and optionally a message
 * table keyed by session id" — so a store that matches can be read by one
 * generic SQL query, and a new tool is a new row here, not a new module.
 *
 * Column candidates are ordered: the first name present in the store wins. The
 * scanner reports which spec a store matches, which is what makes "discovered"
 * different from "readable".
 */

/**
 * @typedef {object} SourceSpec
 * @property {string} id - stable spec id, reported by the scanner.
 * @property {string} shape - human phrase for the store geometry.
 * @property {string[]} sessionTables - acceptable session table names, in order.
 * @property {string[]} messageTables - acceptable message table names (may be empty).
 * @property {Record<string, string[]>} columns - logical field → acceptable column names.
 * @property {Record<string, string[]>} [messageColumns] - same, for the message table.
 */

/** @type {SourceSpec[]} */
export const SOURCE_SPECS = [
  {
    id: 'opencode-like',
    shape: 'session + message + part (opencode and its forks)',
    sessionTables: ['session'],
    messageTables: ['message', 'messages'],
    columns: {
      id: ['id'],
      title: ['title', 'name'],
      workspace: ['directory', 'cwd', 'path'],
      updated: ['time_updated', 'updated_at', 'time_created', 'created_at'],
    },
    messageColumns: {
      session: ['session_id'],
      created: ['time_created', 'created_at'],
    },
  },
  {
    id: 'runtime-state',
    shape: 'local_runtime_sessions + message rows (MiniMax / Mavis)',
    sessionTables: ['local_runtime_sessions'],
    messageTables: ['local_runtime_message_rows', 'local_runtime_messages'],
    columns: {
      id: ['session_id', 'id'],
      title: ['title'],
      workspace: ['workspace_dir', 'cwd'],
      status: ['status'],
      updated: ['updated_at_ms', 'updated_at'],
    },
    messageColumns: {
      session: ['session_id'],
      created: ['created_at_ms', 'created_at'],
    },
  },
  {
    id: 'workbuddy-like',
    shape: 'sessions only, usage in a side table',
    sessionTables: ['sessions'],
    messageTables: [],
    columns: {
      id: ['id', 'session_id'],
      title: ['title'],
      workspace: ['cwd', 'workspace_dir'],
      status: ['status'],
      updated: ['last_activity_at', 'updated_at', 'updated_at_ms'],
    },
  },
  {
    id: 'thread-history',
    shape: 'thread_turns + thread_items (VS Code agent host, codex thread store)',
    sessionTables: ['thread_turns', 'threads'],
    messageTables: ['thread_items'],
    columns: {
      id: ['thread_id', 'id'],
      title: ['title', 'summary'],
      workspace: ['cwd', 'workspace'],
      updated: ['updated_at', 'created_at'],
    },
    messageColumns: {
      session: ['thread_id'],
      created: ['created_at', 'timestamp'],
    },
  },
]

/** First acceptable name that the store actually has. */
function pick(available, candidates) {
  for (const candidate of candidates) {
    if (available.includes(candidate)) return candidate
  }
  return null
}

/**
 * Match a store's table list against the specs.
 * @param {string[]} tables - table names found in the database.
 * @returns `{ spec, resolved } | null` — the spec and the concrete column choices.
 */
export function matchSpec(tables) {
  for (const spec of SOURCE_SPECS) {
    const sessionTable = pick(tables, spec.sessionTables)
    if (!sessionTable) continue
    const messageTable = spec.messageTables.length ? pick(tables, spec.messageTables) : null
    // A spec that needs messages is only a match when the message table exists.
    if (spec.messageTables.length > 0 && !messageTable) continue
    return {
      spec,
      resolved: {
        sessionTable,
        messageTable,
        columns: spec.columns,
        messageColumns: spec.messageColumns ?? {},
      },
    }
  }
  return null
}
