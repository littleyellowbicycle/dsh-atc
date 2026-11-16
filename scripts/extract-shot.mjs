/**
 * Pull the user's screenshot out of the session snapshot and save it as a PNG.
 *
 * The desktop client stores pasted images as base64 blocks inside the session
 * JSONL, so the only way to measure the real sidebar pixels is to decode that
 * payload back into a file.
 *
 * Usage: node scripts/extract-shot.mjs <session.jsonl> <out.png> [timestamp]
 */
import { readFileSync, writeFileSync } from 'node:fs'

const [sessionPath, outPath, stamp] = process.argv.slice(2)
if (!sessionPath || !outPath) {
  console.error('usage: node scripts/extract-shot.mjs <session.jsonl> <out.png> [timestamp]')
  process.exit(1)
}

const raw = readFileSync(sessionPath, 'utf8')
const lines = raw.split('\n').filter(Boolean)

let saved = 0
for (const line of lines) {
  let entry
  try {
    entry = JSON.parse(line)
  } catch {
    continue
  }
  const message = entry && entry.message
  if (!message || message.role !== 'user') continue
  const content = Array.isArray(message.content) ? message.content : []
  for (const part of content) {
    if (!part || part.type !== 'image' || !part.data) continue
    const when = message.timestamp !== undefined ? message.timestamp : entry.timestamp
    if (stamp && String(when) !== stamp) continue
    const name = saved === 0 ? outPath : outPath.replace(/\.png$/, `-${saved}.png`)
    writeFileSync(name, Buffer.from(part.data, 'base64'))
    console.log(`wrote ${name} (${Buffer.from(part.data, 'base64').length} bytes)`)
    saved += 1
  }
}

if (saved === 0) {
  console.error('no user image found')
  process.exit(1)
}
