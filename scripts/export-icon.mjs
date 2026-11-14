/**
 * Rasterise the brand icon to a transparent PNG with headless Edge (CDP).
 *
 * The SVG stays the source of truth; this only produces a flat PNG for places
 * that cannot take an SVG (npm page header, chat clients, Windows shortcut).
 *
 * `node scripts/export-icon.mjs [size]`
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import WebSocket from 'ws'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const size = Number(process.argv[2] || 512)
if (!Number.isFinite(size) || size < 16 || size > 2048) {
  console.error('usage: node scripts/export-icon.mjs [size]  (16..2048)')
  process.exit(2)
}

const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((path) => existsSync(path))
if (!EDGE) {
  console.error('Edge not found')
  process.exit(2)
}

const svg = join(root, 'assets', 'icon.svg')
if (!existsSync(svg)) {
  console.error(`missing ${svg}`)
  process.exit(2)
}

const PORT = 9334
const profile = mkdtempSync(join(tmpdir(), 'dsh-atc-icon-'))
const edge = spawn(
  EDGE,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    `--window-size=${size},${size}`,
    'about:blank',
  ],
  { stdio: 'ignore', detached: false },
)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForDevtools() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (response.ok) return
    } catch {
      /* not up yet */
    }
    await sleep(250)
  }
  throw new Error('devtools endpoint never came up')
}

function connect(url) {
  const socket = new WebSocket(url)
  const pending = new Map()
  let nextId = 1
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString())
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) reject(new Error(message.error.message))
      else resolve(message.result)
    }
  })
  const ready = new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  return {
    ready,
    send(method, params = {}) {
      const id = nextId++
      socket.send(JSON.stringify({ id, method, params }))
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
    },
    close: () => socket.close(),
  }
}

try {
  await waitForDevtools()
  const created = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent('about:blank')}`, {
    method: 'PUT',
  }).then((response) => response.json())

  const cdp = connect(created.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: size,
    height: size,
    deviceScaleFactor: 1,
    mobile: false,
  })

  // A bare <img> on a transparent page: omitBackground then keeps the rounded
  // corners of the tile transparent instead of painting the document canvas.
  const html = `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:transparent}img{display:block;width:${size}px;height:${size}px}</style>
<img src="${pathToFileURL(svg).href}">`
  const page = join(tmpdir(), `dsh-atc-icon-${process.pid}.html`)
  writeFileSync(page, html, 'utf8')

  await cdp.send('Page.navigate', { url: pathToFileURL(page).href })
  await sleep(1200)

  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    omitBackground: true,
    captureBeyondViewport: false,
  })
  const out = join(root, 'assets', `icon-${size}.png`)
  writeFileSync(out, Buffer.from(shot.data, 'base64'))
  console.log(`✓ wrote ${out} (${size}×${size})`)
  cdp.close()
} finally {
  try {
    edge.kill()
  } catch {
    /* already gone */
  }
}
