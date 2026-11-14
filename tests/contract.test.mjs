/**
 * Contract tests: exercise both halves against fake hosts, so the plugin's own
 * wiring is proven without the desktop app running.
 *
 * `node --test tests/contract.test.mjs`
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/* ------------------------------------------------------------------ host */

test('host registers one route and answers the board payload', async () => {
  const host = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)
  assert.equal(host.name, 'dsh-fleet-board')

  const routes = []
  const webCtx = {
    effect: (fn) => fn(),
    webServer: { register: (route) => (routes.push(route), () => {}) },
  }
  const ctx = {
    inject: (services, body) => {
      assert.deepEqual(services, ['webServer'])
      body(webCtx)
    },
  }

  host.apply(ctx)
  assert.equal(routes.length, 1, 'exactly one route')
  assert.equal(routes[0].path, '/dsh-fleet-board')
  assert.equal(routes[0].kind, 'prefix')

  const answer = async (url) => {
    const state = { status: 0, headers: null, body: '' }
    const response = {
      writeHead: (status, headers) => {
        state.status = status
        state.headers = headers
      },
      end: (body) => {
        state.body = body
      },
    }
    await routes[0].handler({ url }, response)
    return state
  }

  const ok = await answer('/dsh-fleet-board/data')
  assert.equal(ok.status, 200)
  assert.match(ok.headers['content-type'], /application\/json/)
  const board = JSON.parse(ok.body)
  assert.ok(Array.isArray(board.items), 'items is an array')
  assert.ok(Array.isArray(board.sources), 'sources is an array')
  assert.equal(typeof board.attention, 'number')
  assert.equal(typeof board.running, 'number')
  assert.equal(typeof board.total, 'number')
  for (const source of board.sources) {
    assert.equal(typeof source.tool, 'string')
    assert.equal(typeof source.available, 'boolean')
  }
  for (const item of board.items) {
    assert.ok(['dsh', 'codex', 'opencode', 'workbuddy'].includes(item.tool), `tool ${item.tool}`)
    assert.equal(typeof item.workspace, 'string')
    assert.equal(typeof item.lastActivity, 'number')
    assert.ok(
      ['running', 'needs-you', 'failed', 'stopped', 'done', 'recent', 'idle'].includes(item.status),
      `status ${item.status}`,
    )
  }

  const miss = await answer('/dsh-fleet-board/nope')
  assert.equal(miss.status, 404)
})

test('inferStatus maps each store vocabulary', async () => {
  const { inferStatus } = await import(pathToFileURL(join(root, 'lib', 'collect.mjs')).href)
  const now = Date.now()
  assert.equal(inferStatus(now, 'working', now), 'running')
  assert.equal(inferStatus(now, 'active', now), 'running')
  assert.equal(inferStatus(now, 'error', now), 'failed')
  assert.equal(inferStatus(now, 'terminated', now), 'stopped')
  assert.equal(inferStatus(now, 'completed', now), 'done')
  assert.equal(inferStatus(now, 'archived', now), 'done')
  assert.equal(inferStatus(now, 'waiting_approval', now), 'needs-you')
  assert.equal(inferStatus(now - 60_000, '', now), 'running')
  assert.equal(inferStatus(now - 10 * 60_000, '', now), 'recent')
  assert.equal(inferStatus(now - 5 * 3600_000, '', now), 'idle')
})

/* ---------------------------------------------------------------- client */

const ReactForBundle = await import('react')

function loadClient() {
  const source = readFileSync(join(root, 'client', 'client.js'), 'utf8')
  let definition = null
  const sandbox = {
    setInterval: () => 0,
    clearInterval: () => {},
    fetch: async () => {
      throw new Error('network disabled in tests')
    },
  }
  sandbox.window = {
    __ModuleLoader__: {
      load: (loaded) => {
        assert.equal(loaded.id, 'dsh-fleet-board')
        definition = loaded.factory((spec) => {
          if (spec === 'react') return ReactForBundle
          throw new Error(`unexpected require(${spec})`)
        })
      },
    },
  }
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client/client.js' })
  assert.ok(definition, 'factory returned a definition')
  return definition
}

test('client registers one tab type and two keyed slot bodies', () => {
  const definition = loadClient()
  assert.equal(definition.name, 'dsh-fleet-board')
  // The tab surface is waited for inside `apply`, so the plugin itself declares
  // no hard dependency (a host without the right sidebar must still boot).
  assert.deepEqual([...definition.inject], [])

  const tabs = []
  const slots = []
  const services = {
    sidebarRightTabs: { register: (tab) => (tabs.push(tab), () => {}) },
    slots: { register: (options, component) => (slots.push({ options, component }), () => {}) },
  }
  const ctx = {
    effect: (fn) => fn(),
    inject: (names, body) => {
      assert.deepEqual([...names], ['sidebarRightTabs', 'slots'])
      body({ ...services, effect: (fn) => fn() })
    },
  }

  definition.apply(ctx)

  assert.equal(tabs.length, 1, 'one tab type registered')
  const tab = tabs[0]
  assert.equal(tab.id, 'dsh-fleet-board')
  assert.equal(tab.kind, 'fleet-board')
  assert.equal(tab.priority, 'extension')
  assert.equal(typeof tab.title, 'function')
  assert.equal(tab.title(), '多 Agent 看板')
  assert.equal(tab.guide.length, 1)
  assert.equal(typeof tab.guide[0].title(), 'string')

  assert.equal(slots.length, 2, 'body + title registered')
  const names = slots.map((entry) => entry.options.name).sort()
  assert.deepEqual(names, ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title'])
  for (const entry of slots) {
    assert.equal(entry.options.key, 'dsh-fleet-board', 'keyed by the tab id')
    assert.equal(typeof entry.component, 'function', 'component is the second positional argument')
  }
})
