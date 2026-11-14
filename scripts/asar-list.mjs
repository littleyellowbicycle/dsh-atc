/**
 * List files inside an .asar archive (read-only).
 * `node scripts/asar-list.mjs <asar path> [regex]`
 */
import { readFileSync, openSync, readSync, statSync } from 'node:fs'

const target = process.argv[2]
const filter = process.argv[3] ? new RegExp(process.argv[3], 'i') : null

const fd = openSync(target, 'r')
const head = Buffer.alloc(16)
readSync(fd, head, 0, 16, 0)
const headerSize = head.readUInt32LE(12)
const buffer = Buffer.alloc(headerSize)
readSync(fd, buffer, 0, headerSize, 16)
const tree = JSON.parse(buffer.toString('utf8'))

const rows = []
function walk(node, prefix) {
  for (const [name, entry] of Object.entries(node.files ?? {})) {
    const path = prefix ? `${prefix}/${name}` : name
    if (entry.files) walk(entry, path)
    else rows.push({ path, size: entry.size ?? 0, offset: entry.offset ?? '' })
  }
}
walk(tree, '')

for (const row of rows) {
  if (filter && !filter.test(row.path)) continue
  console.log(`${String(row.size).padStart(9)}  ${row.path}`)
}
console.log(`\n${rows.length} files total`)
