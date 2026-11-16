/**
 * How expensive would "what is it doing right now" be inside the poll?
 *
 * Walks the tail of the newest session backwards until it finds the last
 * tool/call, and reports frames decoded + time taken.
 */

import { openSync, readSync, closeSync, statSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const root = join(homedir(), '.dsh', 'sessions')
const files = []
for (const ws of readdirSync(root)) {
  for (const entry of readdirSync(join(root, ws), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = join(root, ws, entry.name, 'session.v4.jsonl.zstd')
    try {
      files.push({ file, mtime: statSync(file).mtimeMs, size: statSync(file).size })
    } catch {
      /* skip */
    }
  }
}
files.sort((a, b) => b.mtime - a.mtime)

const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function lastCall(file) {
  const size = statSync(file).size
  const window = Math.min(size, 96 * 1024)
  const buffer = Buffer.alloc(window)
  const fd = openSync(file, 'r')
  try {
    readSync(fd, buffer, 0, window, size - window)
  } finally {
    closeSync(fd)
  }
  const offsets = []
  let i = 0
  while ((i = buffer.indexOf(magic, i)) !== -1) {
    offsets.push(i)
    i += 4
  }
  let frames = 0
  for (let k = offsets.length - 1; k >= 1; k -= 1) {
    frames += 1
    let events
    try {
      events = zstdDecompressSync(buffer.subarray(offsets[k]))
        .toString('utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    } catch {
      continue
    }
    for (let e = events.length - 1; e >= 0; e -= 1) {
      const event = events[e]
      if (event.type !== 'tool/call') continue
      const args = (() => {
        try {
          return JSON.parse(event.data?.arguments ?? '{}')
        } catch {
          return {}
        }
      })()
      const target = args.description || args.command || args.file_path || args.pattern || args.path || ''
      return { frames, name: event.data?.name, target: String(target).slice(0, 90) }
    }
  }
  return { frames, name: null, target: '' }
}

let total = 0
let frames = 0
for (const file of files.slice(0, 40)) {
  const started = Date.now()
  const result = lastCall(file.file)
  const took = Date.now() - started
  total += took
  frames += result.frames
  if (files.indexOf(file) < 6) {
    console.log(`${String(result.frames).padStart(3)} 帧  ${String(took).padStart(4)} ms  ${result.name ?? '-'}  ${result.target}`)
  }
}

console.log(`\n40 个会话：共 ${frames} 帧、${total} ms，平均 ${(total / 40).toFixed(1)} ms/会话`)
