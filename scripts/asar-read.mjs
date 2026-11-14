/**
 * Read one file out of an .asar archive (read-only).
 * `node scripts/asar-read.mjs <asar path> <file path inside archive>`
 */
import { openSync, readSync } from 'node:fs'

const [target, wanted] = process.argv.slice(2)

const fd = openSync(target, 'r')
const head = Buffer.alloc(16)
readSync(fd, head, 0, 16, 0)
const headerSize = head.readUInt32LE(12)
const buffer = Buffer.alloc(headerSize)
readSync(fd, buffer, 0, headerSize, 16)
const tree = JSON.parse(buffer.toString('utf8'))

// The payload starts right after the header block, aligned to 4 bytes.
const dataStart = 16 + Math.ceil(headerSize / 4) * 4

let node = tree
for (const part of wanted.split('/')) {
  node = node?.files?.[part]
  if (!node) throw new Error(`not found: ${wanted}`)
}

const offset = dataStart + Number(node.offset)
const body = Buffer.alloc(node.size)
readSync(fd, body, 0, node.size, offset)
process.stdout.write(body)
