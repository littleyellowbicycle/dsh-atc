/**
 * Field-level rules shared by every collector.
 *
 * Each store names and shapes these things differently, but the decision is the
 * same each time: what counts as a timestamp, what counts as a title, and which
 * of the three possible title sources wins. Keeping the decisions here means a
 * fix lands once instead of four times — the opencode, ZCode and MiniMax stores
 * are close enough that their collectors had drifted apart on details nobody
 * intended.
 */

/**
 * Epoch milliseconds from a number, a numeric string or a date string.
 *
 * Stores disagree on units: some count seconds, some milliseconds, a few hand
 * back ISO strings. Anything above 1e12 is already milliseconds (that is year
 * 2001 in ms), so the test is a unit guess, not a range check.
 */
export function toMs(value) {
  if (value === null || value === undefined) return 0
  if (typeof value === 'number') return value > 1e12 ? value : value * 1000
  const parsed = Date.parse(String(value))
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Strip the machine-instruction preamble agents put ahead of the real ask.
 *
 * Gemini wraps its whole rule block in leading `[..]`, and markdown headings in
 * a pasted prompt are structure rather than a name.
 */
export function cleanPrompt(text) {
  let value = String(text ?? '').replace(/\r/g, '')
  value = value.replace(/^\s*\[[^\]]*\]\s*/i, '')
  value = value.replace(/^\s*#{1,6}\s*/, '')
  return value.replace(/\s+/g, ' ').trim()
}

/** Cut a prompt down to title length, marking the cut. */
export function shortPrompt(text, limit = 40) {
  const value = String(text ?? '')
  if (value === '') return ''
  return `${value.slice(0, limit)}${value.length > limit ? '…' : ''}`
}

/** A prompt as a title: rules block removed first, then shortened. */
export function titleFromPrompt(text, limit = 40) {
  const clean = cleanPrompt(text)
  return clean === '' ? '' : shortPrompt(clean, limit)
}

/** Whether a log line is machine instruction rather than something a person asked. */
export function isSyntheticPrompt(text) {
  const value = String(text ?? '').trimStart()
  return (
    value.startsWith('<') ||
    /^#?\s*AGENTS\.md instructions/i.test(value) ||
    /^#?\s*AGENTS\.md\b/i.test(value) ||
    /^(environment_context|skills_instructions|user_instructions)/i.test(value)
  )
}

/**
 * Names a store writes before anyone has named the session.
 *
 * `opencode` writes "New session - <ISO timestamp>" at creation and only
 * replaces it if the user renames. Showing that as a title reads like a name
 * while saying nothing, so such a name loses to the first prompt.
 *
 * Deliberately only this prefix: it is the shape one store actually emits.
 * Guessing at other placeholder wordings would change what the other sources
 * show, and "未命名 · ab12" is a label this plugin generates, not a name a
 * store hands over.
 */
const PLACEHOLDER_TITLE = /^new session\b/i

/** True when a store-supplied name carries no information. */
export function isPlaceholderTitle(value) {
  const name = String(value ?? '').trim()
  return name === '' || PLACEHOLDER_TITLE.test(name)
}

/**
 * Decide which of the three title sources wins.
 *
 * @param declared - the name the store itself wrote (`undefined` when it has none).
 * @param prompt - the first thing the user asked, already shortened.
 * @param fallback - a label made from an id, for sessions with neither.
 * @param distrustDeclared - the store writes placeholders, so a prompt outranks
 *   the name. Only `opencode` does this; the flag keeps every other source's
 *   behaviour exactly as it was.
 */
export function resolveTitle({ declared, prompt = '', fallback = '', distrustDeclared = false }) {
  const name = typeof declared === 'string' ? declared.trim() : ''
  const usable = name !== '' && !(distrustDeclared && PLACEHOLDER_TITLE.test(name))
  if (usable) return name
  if (prompt !== '') return prompt
  // A placeholder still beats "unknown", and an empty name falls back to the id.
  return name !== '' ? name : fallback
}

/**
 * A short id for a session, for telling apart rows that share a title.
 *
 * Four characters are enough to disambiguate and short enough not to compete
 * with the title. The id is taken from whatever identifies the row — the host
 * session id, the id its own tool accepts, or the store key — with the path and
 * extension stripped so a filename ending does not become the suffix.
 */
export function shortSessionId(item) {
  const raw = String(item?.sessionId || item?.openId || item?.key || '')
  const base = raw.replace(/\\/g, '/').split('/').pop() ?? ''
  const cleaned = base
    .replace(/\.[a-z0-9]{1,6}$/i, '')
    .replace(/^session-/, '')
    .replace(/[^0-9a-zA-Z]/g, '')
  return cleaned.slice(-4)
}

/**
 * Mark the rows whose title alone cannot be told apart.
 *
 * Two sessions can share a title for honest reasons: an automation runs daily,
 * or one prompt was submitted twice. They are different sessions and must stay
 * separate rows — but a reader looking at two identical cards has no way to know
 * that. Only colliding rows get an id; everything else stays clean.
 *
 * A collision only counts **within one day**: rows on different days are already
 * told apart by the date line, and the daily automations would otherwise all
 * collect an id (19 groups become 7 with this scope on one machine).
 *
 * @returns how many rows were marked.
 */
export function markDuplicateTitles(items) {
  const day = (item) => {
    const at = Number(item.lastActivity)
    return Number.isFinite(at) && at > 0 ? new Date(at).toDateString() : "?"
  }
  const signature = (item) => `${item.tool}|${item.title}|${item.workspace}|${day(item)}`
  const counts = new Map()
  for (const item of items) counts.set(signature(item), (counts.get(signature(item)) ?? 0) + 1)
  let marked = 0
  for (const item of items) {
    if ((counts.get(signature(item)) ?? 0) < 2) continue
    const id = shortSessionId(item)
    if (id === '') continue
    item.disambiguator = id
    marked += 1
  }
  return marked
}
