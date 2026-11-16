/**
 * Print the pixel metrics of one rectangle of a screenshot: ink count, ink
 * bounding box, and an ASCII rendering of the pixels.
 *
 * Used to measure the host's own sidebar icons, so the plugin's icon can be
 * tuned to the same ink footprint instead of to a guess.
 *
 * Usage: node scripts/inspect-rect.mjs <shot.png> <x> <y> <w> <h> [threshold]
 */
import { readFileSync } from 'node:fs'
import { decodePng } from './measure-icons.mjs'

const [path, xArg, yArg, wArg, hArg, thresholdArg] = process.argv.slice(2)
const x0 = Number(xArg)
const y0 = Number(yArg)
const w = Number(wArg)
const h = Number(hArg)
const threshold = Number(thresholdArg ?? 190)

const image = decodePng(readFileSync(path))

let ink = 0
let minX = Infinity
let maxX = -Infinity
let minY = Infinity
let maxY = -Infinity
let sumR = 0
let sumG = 0
let sumB = 0
let darkest = 255
const rows = []

for (let y = y0; y < y0 + h; y += 1) {
  let row = ''
  for (let x = x0; x < x0 + w; x += 1) {
    const o = (y * image.width + x) * 4
    const r = image.data[o]
    const g = image.data[o + 1]
    const b = image.data[o + 2]
    const lum = 0.299 * r + 0.587 * g + 0.114 * b
    if (lum < darkest) darkest = lum
    if (lum < threshold) {
      ink += 1
      sumR += r
      sumG += g
      sumB += b
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
      row += lum < 150 ? '#' : '+'
    } else {
      row += lum < 235 ? '.' : ' '
    }
  }
  rows.push(`${String(y).padStart(4)} ${row}`)
}

console.log(rows.join('\n'))
console.log(
  `\nink=${ink}px  bbox=${maxX - minX + 1}x${maxY - minY + 1} at (${minX},${minY})  ` +
    `meanInk=rgb(${Math.round(sumR / ink)},${Math.round(sumG / ink)},${Math.round(sumB / ink)})  ` +
    `darkestLum=${Math.round(darkest)}`,
)
