/**
 * Crop a region of a PNG and blow it up, so icon pixels can be compared by eye.
 *
 * Writes a nearest-neighbour zoom of the crop as a new PNG. Used to put our
 * panel icon next to the host's own sidebar icons at the same magnification.
 *
 * Usage: node scripts/crop-zoom.mjs <in.png> <out.png> <x> <y> <w> <h> [scale]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { decodePng } from './measure-icons.mjs'

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

/** CRC-32 of a buffer, as PNG chunks want it. */
function crc32(buffer) {
  let c = 0xffffffff
  for (let i = 0; i < buffer.length; i += 1) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** Wrap raw RGBA bytes in PNG chunks. */
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  const chunks = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])]
  const chunk = (type, body) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(body.length, 0)
    head.write(type, 4, 'ascii')
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0)
    return Buffer.concat([head, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  chunks.push(chunk('IHDR', ihdr))
  chunks.push(chunk('IDAT', deflateSync(raw)))
  chunks.push(chunk('IEND', Buffer.alloc(0)))
  return Buffer.concat(chunks)
}

const [inPath, outPath, xArg, yArg, wArg, hArg, scaleArg] = process.argv.slice(2)
const x = Number(xArg)
const y = Number(yArg)
const w = Number(wArg)
const h = Number(hArg)
const scale = Number(scaleArg ?? 6)
const image = decodePng(readFileSync(inPath))
const zoom = encodePng(w * scale, h * scale, (() => {
  const out = Buffer.alloc(w * scale * h * scale * 4)
  for (let dy = 0; dy < h * scale; dy += 1) {
    for (let dx = 0; dx < w * scale; dx += 1) {
      const sx = Math.min(image.width - 1, x + Math.floor(dx / scale))
      const sy = Math.min(image.height - 1, y + Math.floor(dy / scale))
      const s = (sy * image.width + sx) * 4
      const o = (dy * w * scale + dx) * 4
      out[o] = image.data[s]
      out[o + 1] = image.data[s + 1]
      out[o + 2] = image.data[s + 2]
      out[o + 3] = 255
    }
  }
  return out
})())

writeFileSync(outPath, zoom)
console.log(`wrote ${outPath}: ${w}x${h} -> ${w * scale}x${h * scale} (${scale}x)`)
