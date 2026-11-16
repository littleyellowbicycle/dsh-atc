/**
 * Measure the ink footprint of the sidebar icons in a screenshot.
 *
 * The plugin's panel icon has to carry the same visual weight as the host's
 * own rows, and the only honest way to judge that is the rendered pixels.
 * This decodes a PNG without dependencies, finds the dark ink clusters in the
 * icon column, and reports each cluster's bounding box plus how much of that
 * box is actually ink.
 *
 * Usage: node scripts/measure-icons.mjs <shot.png> [xMin] [xMax]
 */
import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

/** Decode a PNG buffer into raw RGBA pixels. */
export function decodePng(buffer) {
  let pos = 8
  let width = 0
  let height = 0
  let bitDepth = 8
  let colorType = 6
  let interlace = 0
  const idat = []
  let palette = null
  let transparency = null

  while (pos < buffer.length) {
    const length = buffer.readUInt32BE(pos)
    const type = buffer.toString('ascii', pos + 4, pos + 8)
    const body = buffer.subarray(pos + 8, pos + 8 + length)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      bitDepth = body[8]
      colorType = body[9]
      interlace = body[12]
    } else if (type === 'PLTE') {
      palette = body
    } else if (type === 'tRNS') {
      transparency = body
    } else if (type === 'IDAT') {
      idat.push(body)
    } else if (type === 'IEND') {
      break
    }
    pos += 12 + length
  }

  if (interlace !== 0) throw new Error('interlaced PNG not supported')
  if (bitDepth !== 8) throw new Error(`bit depth ${bitDepth} not supported`)

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]
  if (!channels) throw new Error(`colour type ${colorType} not supported`)

  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(width * height * 4)
  let prev = Buffer.alloc(stride)

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride))
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? line[i - channels] : 0
      const b = prev[i]
      const c = i >= channels ? prev[i - channels] : 0
      let value = line[i]
      if (filter === 1) value += a
      else if (filter === 2) value += b
      else if (filter === 3) value += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      line[i] = value & 0xff
    }
    prev = line

    for (let x = 0; x < width; x += 1) {
      const base = x * channels
      let r
      let g
      let b
      let a = 255
      if (colorType === 6) {
        r = line[base]
        g = line[base + 1]
        b = line[base + 2]
        a = line[base + 3]
      } else if (colorType === 2) {
        r = line[base]
        g = line[base + 1]
        b = line[base + 2]
      } else if (colorType === 0) {
        r = g = b = line[base]
      } else if (colorType === 4) {
        r = g = b = line[base]
        a = line[base + 1]
      } else {
        const index = line[base]
        r = palette[index * 3]
        g = palette[index * 3 + 1]
        b = palette[index * 3 + 2]
        a = transparency && index < transparency.length ? transparency[index] : 255
      }
      const o = (y * width + x) * 4
      out[o] = r
      out[o + 1] = g
      out[o + 2] = b
      out[o + 3] = a
    }
  }

  return { width, height, data: out }
}

const path = process.argv[2]
if (path && process.argv[1] && process.argv[1].endsWith('measure-icons.mjs')) {
  main(path)
}

/** Run the CLI measurement against one screenshot. */
function main(path) {
const xMin = Number(process.argv[3] ?? 12)
const xMax = Number(process.argv[4] ?? 34)
const image = decodePng(readFileSync(path))

console.log(`${path}: ${image.width}x${image.height}, scanning x ${xMin}..${xMax}`)

/** Ink = pixels clearly darker than the sidebar background. */
function inkAt(x, y) {
  const o = (y * image.width + x) * 4
  const r = image.data[o]
  const g = image.data[o + 1]
  const b = image.data[o + 2]
  const a = image.data[o + 3]
  if (a < 40) return 0
  const lum = 0.299 * r + 0.587 * g + 0.114 * b
  return lum < 190 ? 1 : 0
}

const rows = []
for (let y = 0; y < image.height; y += 1) {
  let count = 0
  for (let x = xMin; x <= xMax; x += 1) count += inkAt(x, y)
  rows.push(count)
}

// Group rows with ink into bands: each band is one icon.
const bands = []
let start = -1
for (let y = 0; y <= image.height; y += 1) {
  const hit = y < image.height && rows[y] > 0
  if (hit && start === -1) start = y
  if (!hit && start !== -1) {
    bands.push([start, y - 1])
    start = -1
  }
}

console.log('\nband   y-range    h   x-range    w  ink  ink%')
for (const [y0, y1] of bands) {
  if (y1 - y0 < 2) continue
  let minX = Infinity
  let maxX = -Infinity
  let ink = 0
  for (let y = y0; y <= y1; y += 1) {
    for (let x = xMin; x <= xMax; x += 1) {
      if (inkAt(x, y)) {
        ink += 1
        if (x < minX) minX = x
        if (x > maxX) maxX = x
      }
    }
  }
  const h = y1 - y0 + 1
  const w = maxX - minX + 1
  const pct = ((ink / (h * w)) * 100).toFixed(1)
  console.log(
    `${String(y0).padStart(4)}  ${String(y0).padStart(3)}-${String(y1).padStart(3)}  ${String(h).padStart(3)}  ${String(minX).padStart(3)}-${String(maxX).padStart(3)}  ${String(w).padStart(3)}  ${String(ink).padStart(4)}  ${pct}%`,
  )
}
}
