/**
 * Offline render check: feed the real host payload into the real Board
 * component with real React, print what a user would see, and write an HTML
 * preview. Proves the client half renders rows without DSH running.
 *
 * `node scripts/render-check.mjs`
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { collectBoard } from '../lib/collect.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Load the browser bundle the way the DSH module loader would. */
function loadClient() {
  const source = readFileSync(join(root, 'client', 'client.js'), 'utf8')
  let definition = null
  const sandbox = {
    fetch: async () => {
      throw new Error('network disabled')
    },
    setInterval: () => 0,
    clearInterval: () => {},
    Date,
    console,
  }
  sandbox.window = {
    __ModuleLoader__: {
      load: ({ id, factory }) => {
        if (id !== 'dsh-fleet-board') throw new Error(`unexpected id ${id}`)
        definition = factory((spec) => {
          if (spec === 'react') return { ...ReactForBundle }
          throw new Error(`unexpected require(${spec})`)
        })
      },
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client/client.js' })
  if (!definition) throw new Error('client factory never ran')
  return definition
}

// The bundle calls React.createElement at module scope, so the shim must carry
// the real implementation before the factory runs.
const ReactForBundle = await import('react')

const definition = loadClient()
const board = await collectBoard()

// Seed the module store: this is the exact payload the host route serves.
definition.__test.store.data = board
definition.__test.store.at = Date.now()

const html = renderToStaticMarkup(createElement(definition.__test.Board))
const title = renderToStaticMarkup(createElement(definition.__test.TabTitle))

const strip = (value) => value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

console.log(`tab title : ${strip(title)}`)
console.log(`text      : ${strip(html).slice(0, 400)}…\n`)

const missing = board.items
  .slice(0, 8)
  .map((item) => item.title)
  .filter((text) => !html.includes(String(text).slice(0, 12)))
if (missing.length > 0) {
  console.error(`✗ rows did not render: ${missing.join(' | ')}`)
  process.exit(1)
}
if (!html.includes('多 Agent 看板')) {
  console.error('✗ panel header missing')
  process.exit(1)
}
if (!html.includes(`${board.items.length}`)) {
  console.error('✗ session count missing')
  process.exit(1)
}
if (!html.includes(`多 Agent 看板 (${board.attention})`) && board.attention > 0) {
  console.error('✗ attention badge missing from the tab title')
  process.exit(1)
}

writeFileSync(
  join(root, 'render-check.html'),
  `<!doctype html><meta charset="utf-8"><title>dsh-fleet-board render check</title>
<body style="margin:0;background:#1b1d21;color:#e6e8eb;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;width:360px">
${html}
</body>`,
  'utf8',
)

console.log(`✓ rendered ${board.items.length} rows, ${board.sources.length} sources, attention=${board.attention}`)
console.log('✓ wrote render-check.html')
