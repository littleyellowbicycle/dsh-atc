/**
 * The detail drawer's data: what a session has been doing, turn by turn.
 *
 * Only DSH can answer this — its log records tool calls with durations. Other
 * sources get `supported: false` rather than a lookalike summary built from
 * whatever fields happen to exist, because a drawer that says "tool calls: none"
 * for a tool with no such concept is worse than one that says so.
 *
 * Read on demand only: this walks more of the log than the poll does, and a card
 * click is the moment someone asked for it.
 */

import { statSync } from 'node:fs'
import { walkTail } from './dsh-frames.mjs'
import { callTarget } from './tool-calls.mjs'

/** How many calls the drawer shows, and how far back it will look for them. */
const MAX_CALLS = 12
const MAX_FRAMES = 400
const DETAIL_WINDOW = 384 * 1024

/** Result content orients the reader; it is not the drawer's subject. */
const SNIPPET = 240

function snippet(content) {
  if (!Array.isArray(content)) return ''
  const text = content
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (text === '') return ''
  return text.length > SNIPPET ? `${text.slice(0, SNIPPET)}…` : text
}

/**
 * Read one DSH session log into the shape the drawer renders.
 *
 * Calls and results are collected separately and paired at the end: the walk
 * goes newest frame first, so a result is seen before the call it belongs to.
 * Pairing as they arrive left every row reading "进行中".
 *
 * @param file - absolute path to `session.v4.jsonl.zstd`.
 */
export function readDshDetail(file) {
  const info = statSync(file)
  const calls = new Map() // callId → what the agent asked for
  const results = new Map() // callId → what came back
  let usage = null
  let lastTurnEnd = null

  walkTail(file, info.size, {
    windowBytes: DETAIL_WINDOW,
    maxFrames: MAX_FRAMES,
    visit(events) {
      for (const event of events) {
        const type = event?.type
        if (type === 'tool/call') {
          const callId = String(event.data?.callId ?? '')
          const name = String(event.data?.name ?? '')
          if (!callId || !name || calls.has(callId)) continue
          calls.set(callId, {
            callId,
            name,
            target: callTarget(event.data?.arguments),
            startedAt: typeof event.time === 'number' ? event.time : 0,
          })
        } else if (type === 'tool/result') {
          const callId = String(event.data?.toolCallId ?? event.data?.message?.source?.callId ?? '')
          if (!callId || results.has(callId)) continue
          const kind = String(event.data?.message?.source?.kind ?? '')
          results.set(callId, {
            endedAt: typeof event.time === 'number' ? event.time : 0,
            // Unknown is reported as unknown: 'error' proves a failure, 'tool'
            // proves a normal read, anything else stays null.
            ok: kind === 'error' ? false : kind === 'tool' ? true : null,
            snippet: snippet(event.data?.message?.content),
          })
        } else if (type === 'assistant/message') {
          // The usage sits beside the message, not inside it.
          const next = event.data?.usage
          if (next && typeof next === 'object') {
            const at = typeof event.time === 'number' ? event.time : 0
            if (!usage || at >= usage.at) {
              usage = {
                at,
                inputTokens: Number(next.inputTokens) || 0,
                outputTokens: Number(next.outputTokens) || 0,
                totalTokens: Number(next.totalTokens) || 0,
                cacheReadTokens: Number(next.cacheReadTokens) || 0,
              }
            }
          }
        } else if (type === 'turn/end' && typeof event.time === 'number') {
          if (!lastTurnEnd || event.time > lastTurnEnd.time) {
            lastTurnEnd = { time: event.time, reason: String(event.data?.reason?.kind ?? '') }
          }
        }
      }
      return calls.size >= MAX_CALLS && usage !== null
    },
  })

  const list = [...calls.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, MAX_CALLS)
    .map((call) => {
      const result = results.get(call.callId)
      return {
        callId: call.callId,
        name: call.name,
        target: call.target,
        startedAt: call.startedAt,
        durationMs: result?.endedAt && call.startedAt ? result.endedAt - call.startedAt : null,
        ok: result ? result.ok : null,
        finished: Boolean(result),
        snippet: result?.snippet ?? '',
      }
    })

  return {
    supported: true,
    calls: list,
    usage: usage
      ? {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.totalTokens,
          cacheReadTokens: usage.cacheReadTokens,
        }
      : null,
    lastTurn: lastTurnEnd,
    totalCalls: calls.size,
    bytes: info.size,
  }
}
