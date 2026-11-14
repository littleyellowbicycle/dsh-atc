/**
 * Headless live check: open a running DSH web instance in Edge (headless, CDP),
 * confirm the client half actually registered inside the real host, and save a
 * screenshot as evidence.
 *
 * `node scripts/live-check.mjs http://127.0.0.1:60200/?token=...`
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const target = process.argv[2]
const clicks = process.argv
  .slice(3)
  .filter((arg) => arg.startsWith('--click='))
  .map((arg) => arg.slice('--click='.length))
/** Optional post-click expression, for inspecting the live DOM. */
const evalArg = process.argv.slice(3).find((arg) => arg.startsWith('--eval='))
const evalFile = process.argv.slice(3).find((arg) => arg.startsWith('--eval-file='))
const evalExpression = evalFile
  ? readFileSync(evalFile.slice('--eval-file='.length), 'utf8')
  : evalArg?.slice('--eval='.length)
if (!target) {
  console.error(
    'usage: node scripts/live-check.mjs <url-with-token> [--click=<aria-label>]... [--eval=<expression>]',
  )
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

const PORT = 9333
const profile = mkdtempSync(join(tmpdir(), 'dsh-atc-edge-'))
const edge = spawn(
  EDGE,
  [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--window-size=1440,900',
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
  const events = []
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString())
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) reject(new Error(message.error.message))
      else resolve(message.result)
    } else if (message.method) {
      events.push(message)
    }
  })
  const ready = new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  return {
    ready,
    events,
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
  await cdp.send('Page.navigate', { url: target })

  // The web app boots its client plugin tree after load; give it room.
  await sleep(9000)

  for (const label of clicks) {
    const clicked = await cdp.send('Runtime.evaluate', {
      expression: `(() => {
        const wanted = ${JSON.stringify(label)}
        const nodes = Array.from(document.querySelectorAll('button,[role="button"],[role="tab"],[role="menuitem"]'))
        const hit = nodes.find((el) => {
          const hay = [
            el.getAttribute('aria-label') || '',
            el.getAttribute('title') || '',
            el.innerText || '',
          ].join(' ')
          return hay.includes(wanted)
        })
        if (!hit) return false
        hit.click()
        return true
      })()`,
      returnByValue: true,
    })
    console.log(`click "${label}": ${clicked.result.value ? 'ok' : 'not found'}`)
    await sleep(1800)
  }

  const probe = await cdp.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      hooked: !!globalThis.__dshFleetBoard,
      at: globalThis.__dshFleetBoard ? globalThis.__dshFleetBoard.at : null,
      title: document.title,
      hasFleetText: document.body.innerText.includes('澶?Agent 鐪嬫澘'),
      bodyLength: document.body.innerText.length,
      bodyText: document.body.innerText.slice(0, 2600),
      buttons: Array.from(document.querySelectorAll('button,[role="button"]'))
        .slice(0, 40)
        .map((el) => (el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || '').trim().slice(0, 40))
        .filter(Boolean),
      errors: (globalThis.__dshBootErrors || []).slice(0, 5)
    })`,
    returnByValue: true,
  })

  if (evalExpression) {
    const custom = await cdp.send('Runtime.evaluate', { expression: evalExpression, returnByValue: true, awaitPromise: true })
    console.log('custom:', JSON.stringify(custom.result.value))
  }
  if (process.argv.includes('--console')) {
    for (const event of cdp.events) {
      if (event.method === 'Runtime.exceptionThrown') {
        const detail = event.params?.exceptionDetails
        console.log('exception:', (detail?.exception?.description ?? detail?.text ?? '').split('\n').slice(0, 6).join(' | '))
      }
      if (event.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(event.params?.type)) {
        const text = (event.params.args ?? []).map((a) => a.description ?? a.value ?? '').join(' ')
        console.log('console.' + event.params.type + ':', String(text).split('\n').slice(0, 4).join(' | ').slice(0, 300))
      }
    }
  }
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  const file = join(root, 'live-check.png')
  writeFileSync(file, Buffer.from(shot.data, 'base64'))

  const result = JSON.parse(probe.result.value)
  console.log('probe:', JSON.stringify(result, null, 2))
  console.log(`screenshot: ${file}`)

  if (!result.hooked) {
    console.error('鉁?client plugin did NOT register in the real host')
    process.exitCode = 1
  } else {
    console.log('鉁?client plugin registered inside the live DSH host')
  }
  cdp.close()
} finally {
  try {
    edge.kill()
  } catch {
    /* already gone */
  }
}

