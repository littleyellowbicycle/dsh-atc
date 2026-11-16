/**
 * Capture the board as a canonical snapshot, so a refactor can be proven to
 * change nothing. `node scripts/board-snapshot.mjs out.json`
 *
 * Deliberately records only what a refactor must not change: which tool, which
 * session, its title, workspace, status and detail. Timestamps are kept because
 * they are derived from files, but they are the part most likely to drift by a
 * second between runs — compare with `--ignore-time` if only that moved.
 */

import { writeFileSync } from 'node:fs'
import { collectBoard } from '../lib/collect.mjs'

const out = process.argv[2]
if (!out) {
  console.error('usage: node scripts/board-snapshot.mjs <out.json>')
  process.exit(2)
}

const board = await collectBoard()
const snapshot = {
  sources: board.sources.map((source) => ({
    tool: source.tool,
    available: source.available,
    count: source.count ?? (source.items ? source.items.length : 0),
    reason: source.reason ?? '',
  })),
  items: board.items.map((item) => ({
    tool: item.tool,
    key: item.key ?? '',
    title: item.title,
    workspace: item.workspace,
    status: item.status,
    detail: item.detail ?? '',
    doing: item.doing ?? '',
    lastActivity: item.lastActivity,
    sessionId: item.sessionId ?? '',
  })),
  attention: board.attention,
  running: board.running,
  total: board.total,
}

writeFileSync(out, JSON.stringify(snapshot, null, 2) + '\n')
console.log(`wrote ${out} · ${snapshot.items.length} items · ${snapshot.sources.length} sources`)
