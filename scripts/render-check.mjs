/**
 * Offline render check: feed the real host payload into the real page
 * component with real React, print what a user would see, and write an HTML
 * preview. Proves the page renders rows without DSH running.
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
const ReactForBundle = await import('react')

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
    setTimeout: () => 0,
    navigator: { clipboard: { writeText: async () => {} } },
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

const definition = loadClient()
const board = await collectBoard()

// Seed the module store: this is the exact payload the host route serves.
definition.__test.store.data = board
definition.__test.store.at = Date.now()

const fakeCtx = { get: () => null }
const html = renderToStaticMarkup(createElement(definition.__test.FleetPage, { ctx: fakeCtx }))
const strip = (value) =>
  value
    .replace(/<style>[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

console.log(`text: ${strip(html).slice(0, 420)}…\n`)

// Only the bands that render open by default can be asserted on.
const visible = board.items.filter((item) =>
  ['needs-you', 'failed', 'running', 'recent'].includes(item.status),
)
const missing = visible
  .slice(0, 8)
  .map((item) => item.title)
  .filter((text) => !html.includes(String(text).slice(0, 12)))
if (missing.length > 0) {
  console.error(`✗ rows did not render: ${missing.join(' | ')}`)
  process.exit(1)
}
for (const expected of ['多 Agent 看板', '在跑', '等你']) {
  if (!html.includes(expected)) {
    console.error(`✗ missing text: ${expected}`)
    process.exit(1)
  }
}

writeFileSync(
  join(root, 'render-check.html'),
  `<!doctype html><meta charset="utf-8"><title>dsh-fleet-board render check</title>
<body style="margin:0;background:#fff;color:#1b1d21;font-family:system-ui,-apple-system,'Segoe UI',sans-serif">
<style>:root{--dsw-alias-label-primary:#1b1d21;--dsw-alias-label-secondary:#4a5568;--dsw-alias-label-tertiary:#6b7280;--dsw-alias-label-quaternary:#9aa3b2;--dsw-alias-label-error:#c0392b;--dsw-alias-border-l1:#eceef1;--dsw-alias-border-l2:#dfe3e8;--dsw-alias-separator-primary:#eceef1;--dsw-alias-card-fill:#fafbfc;--dsw-alias-button-elevated-fill:#f4f5f7;--dsw-alias-interactive-bg-hover:#f2f4f7;--dsw-alias-state-success-primary:#2f9e6f;--dsw-alias-state-warn-primary:#d98324;--dsw-alias-state-error-primary:#c0392b;--dsw-alias-state-error-secondary:#f3c2bd;--dsw-alias-state-business-primary:#7048e8;--dsw-alias-brand-primary:#4c6ef5}</style>
${html}
</body>`,
  'utf8',
)

console.log(`✓ rendered ${board.items.length} rows, ${board.sources.length} sources, attention=${board.attention}`)
console.log('✓ wrote render-check.html')
