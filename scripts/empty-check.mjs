/**
 * Offline check of the empty state: seed the store with an empty board and
 * assert the page explains itself instead of rendering nothing.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const ReactForBundle = await import('react')
const source = readFileSync(join(root, 'client', 'client.js'), 'utf8')

let definition = null
const sandbox = {
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: () => 0,
  fetch: async () => {
    throw new Error('offline')
  },
  navigator: { clipboard: { writeText: async () => {} } },
  Date,
  console,
}
sandbox.window = {
  __ModuleLoader__: {
    load: ({ id, factory }) => {
      if (id !== 'dsh-atc') throw new Error(`unexpected id ${id}`)
      definition = factory((spec) => {
        if (spec === 'react') return { ...ReactForBundle }
        throw new Error(`unexpected require(${spec})`)
      })
    },
  },
}
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client/client.js' })

definition.__test.store.data = {
  generatedAt: Date.now(),
  items: [],
  sources: [],
  agents: [{ tool: 'dsh', parsed: true, path: '~/.dsh/sessions', reason: '' }],
  attention: 0,
  running: 0,
  total: 0,
  discovery: { scannedAt: Date.now(), apps: 3, installable: 1, installableNames: ['AionUi'] },
}
definition.__test.store.at = Date.now()

const html = renderToStaticMarkup(createElement(definition.__test.FleetPage, { ctx: { get: () => null } }))
const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()

const checks = ['还没有可显示的会话', '探测 1 个 agent', '可接入', 'AionUi', '重新扫描']
const missing = checks.filter((needle) => !text.includes(needle))
if (missing.length) {
  console.error('missing:', missing.join(' | '))
  console.error('text:', text.slice(0, 400))
  process.exit(1)
}
console.log('empty state ok →', text.slice(0, 220))
