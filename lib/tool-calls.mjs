/**
 * What a session is doing right now, from its own tool calls.
 *
 * The log records every tool call with a `name` and an `arguments` JSON string,
 * and agents put a human sentence in `arguments.description` whenever the tool
 * has one — that line is written for a person to read, so it is what the board
 * shows. Inventing a summary from the command line would be worse than showing
 * the one the agent already wrote.
 *
 * Everything here is pure: the caller supplies the events.
 */

/** Arguments that carry a human-readable target, most specific first. */
const TARGET_KEYS = [
  'description',
  'file_path',
  'filePath',
  'path',
  'notebook_path',
  'pattern',
  'query',
  'command',
  'url',
  'prompt',
]

/** Longest target worth putting on a card; the drawer can show more. */
const MAX_TARGET = 120

function parseArguments(raw) {
  if (typeof raw !== 'string' || raw === '') return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * A short phrase describing what a tool call is aimed at.
 *
 * Returns '' when the arguments carry nothing usable, so callers can decide to
 * show only the tool name rather than a dangling separator.
 */
export function callTarget(argumentsValue) {
  const args = typeof argumentsValue === 'string' ? parseArguments(argumentsValue) : argumentsValue
  if (!args || typeof args !== 'object') return ''
  for (const key of TARGET_KEYS) {
    const value = args[key]
    if (typeof value !== 'string') continue
    const text = value.replace(/\s+/g, ' ').trim()
    if (text !== '') return text.length > MAX_TARGET ? `${text.slice(0, MAX_TARGET)}…` : text
  }
  return ''
}

/**
 * One `tool/call` event as the board needs it.
 * @returns `{ name, target, time }` or null when the event is not a tool call.
 */
export function summarizeCall(event) {
  if (!event || event.type !== 'tool/call') return null
  const name = typeof event.data?.name === 'string' ? event.data.name : ''
  if (name === '') return null
  return {
    name,
    target: callTarget(event.data?.arguments),
    time: typeof event.time === 'number' ? event.time : 0,
  }
}

/**
 * The one line a running card shows: `name · target`, or just the name when the
 * call carries no description.
 */
export function doingLine(call) {
  if (!call || !call.name) return ''
  return call.target ? `${call.name} · ${call.target}` : call.name
}
