/**
 * Reading a DSH session log: a run of independent zstd frames.
 *
 * The whole-file decoder stops after the first frame, which is why this exists at
 * all — a session log appends one frame per batch of events, so reading "what
 * happened last" means decoding frames from the tail.
 *
 * Kept separate from the collectors because the board reads the newest turn on
 * every poll while the detail drawer reads more of the same file on demand; both
 * need the same three primitives and neither should own them.
 */

import { closeSync, openSync, readSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

/** Frame magic of zstd, searched for to find frame starts inside a window. */
export const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** How much of a log the board reads to answer "title + last turn". */
export const HEAD_WINDOW = 512 * 1024
export const TAIL_WINDOW = 96 * 1024

/** Byte offsets of every zstd frame in a window. */
export function frameOffsets(buffer) {
  const offsets = []
  let cursor = 0
  while (true) {
    const at = buffer.indexOf(ZSTD_MAGIC, cursor)
    if (at === -1) break
    offsets.push(at)
    cursor = at + 4
  }
  return offsets
}

/** Decode one frame's events, or nothing when the slice is truncated. */
export function eventsOfFrame(buffer, at) {
  let text
  try {
    text = zstdDecompressSync(buffer.subarray(at)).toString('utf8')
  } catch {
    return []
  }
  const events = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      /* a half-written line is not an event */
    }
  }
  return events
}

/** Read `length` bytes at `from`. */
export function readWindow(file, size, from, length) {
  const buffer = Buffer.alloc(length)
  const fd = openSync(file, 'r')
  try {
    readSync(fd, buffer, 0, length, from)
  } finally {
    closeSync(fd)
  }
  return buffer
}

/**
 * Walk the tail of a log from the newest frame backwards.
 *
 * @param file - the session log.
 * @param size - the file's size in bytes.
 * @param windowBytes - how much of the tail to load; older frames are not read.
 * @param maxFrames - stop after decoding this many frames.
 * @param visit - called with each frame's events, newest frame first. Return
 *   true to stop the walk.
 * @returns how many frames were decoded.
 */
export function walkTail(file, size, { windowBytes = TAIL_WINDOW, maxFrames = 64, visit }) {
  const length = Math.min(size, windowBytes)
  const window = readWindow(file, size, size - length, length)
  const frames = frameOffsets(window)
  let decoded = 0
  // When the window does not reach the start of the file, its first frame is
  // cut in half and cannot be decoded — skip it. A small log is fully covered,
  // so its first frame is real and must be read.
  const first = size <= length ? 0 : 1
  for (let index = frames.length - 1; index >= first && decoded < maxFrames; index -= 1) {
    decoded += 1
    const events = eventsOfFrame(window, frames[index])
    if (events.length > 0 && visit(events, decoded)) break
  }
  return decoded
}
