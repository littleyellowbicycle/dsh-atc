/**
 * Turning a card into "open that session in its own tool".
 *
 * Only tools whose CLI can be asked to resume a specific session get an opener,
 * and each entry carries the flag as it was verified on the machine — not as it
 * is documented. A tool with no opener keeps the old behaviour (copy the
 * workspace path), because a click that appears to do something and does not is
 * worse than a click that copies.
 *
 * The id is validated rather than trusted: it reaches a command line, and these
 * ids come from a store the board merely reads.
 */

/** `[tool] → how to resume one of its sessions in a terminal. */
export const OPENERS = {
  opencode: {
    label: '在 opencode 里打开',
    command: 'opencode',
    // Verified: `opencode -s <sessionID>` continues that session.
    args: (id) => ['-s', id],
  },
  codex: {
    label: '在 codex 里打开',
    command: 'codex',
    // Verified: `codex resume [SESSION_ID]` takes a UUID.
    args: (id) => ['resume', id],
  },
}

/** Session ids reach a shell, so they are held to a shape that cannot escape one. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/

/** A path the opener may run in: absolute Windows or POSIX, nothing else. */
function absolute(path) {
  const value = String(path ?? '').trim()
  if (/^[A-Za-z]:[\\/]/.test(value)) return value
  if (value.startsWith('/')) return value
  return undefined
}

/**
 * Decide what a click on a card should run.
 *
 * Pure: no spawning, no filesystem. The caller turns the plan into a process,
 * which is what makes this testable without opening terminals.
 *
 * @returns `{ ok: true, tool, command, args, cwd, label }` or `{ ok: false, reason }`
 *   where reason is 'no-opener' | 'bad-id'.
 */
export function planOpen({ tool, openId, cwd }) {
  const opener = OPENERS[String(tool ?? '')]
  if (!opener) return { ok: false, reason: 'no-opener' }
  const id = String(openId ?? '').trim()
  if (!SAFE_ID.test(id)) return { ok: false, reason: 'bad-id' }
  return {
    ok: true,
    tool,
    command: opener.command,
    args: opener.args(id),
    cwd: absolute(cwd),
    label: opener.label,
  }
}

/** Every tool that can be opened, with the label the UI should show. */
export function openerLabels() {
  return Object.fromEntries(Object.entries(OPENERS).map(([tool, opener]) => [tool, opener.label]))
}

/** Whether a tool has an opener at all, for the UI to describe the click. */
export function openerLabel(tool) {
  return OPENERS[String(tool ?? '')]?.label ?? ''
}
