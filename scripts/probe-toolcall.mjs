import { openSync, readSync, closeSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const root = join(homedir(), '.dsh', 'sessions')
const { readdirSync } = await import('node:fs')

// newest session by mtime
let newest = null
for (const ws of readdirSync(root)) {
  for (const entry of readdirSync(join(root, ws), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = join(root, ws, entry.name, 'session.v4.jsonl.zstd')
    try {
      const size = statSync(file).size
      const mtime = statSync(file).mtimeMs
      if (!newest || mtime > newest.mtime) newest = { file, mtime, size, name: entry.name }
    } catch {
      /* skip */
    }
  }
}
console.log('session:', newest.name, (newest.size / 1024 / 1024).toFixed(1), 'MB')

const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const window = Math.min(newest.size, 96 * 1024)
const buffer = Buffer.alloc(window)
const fd = openSync(newest.file, 'r')
try {
  readSync(fd, buffer, 0, window, newest.size - window)
} finally {
  closeSync(fd)
}

const offsets = []
let i = 0
while ((i = buffer.indexOf(magic, i)) !== -1) {
  offsets.push(i)
  i += 4
}

const wanted = ['tool/call', 'tool/result', 'assistant/message', 'step/end']
const samples = new Map()
for (let k = offsets.length - 1; k >= 1 && samples.size < wanted.length; k -= 1) {
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
  for (const event of events) {
    if (wanted.includes(event.type) && !samples.has(event.type)) samples.set(event.type, event)
  }
}

for (const [type, event] of samples) {
  const json = JSON.stringify(event)
  console.log(`\n=== ${type} （${json.length} 字节）===`)
  console.log(json.slice(0, 900))
}
