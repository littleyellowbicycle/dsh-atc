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
  assert.equal(host.name, 'dsh-atc')

  const routes = []
  const webCtx = {
    effect: (fn) => fn(),
    webServer: { register: (route) => (routes.push(route), () => {}) },
  }
  // The board route is the contract that matters here. The plugin stays free
  // to borrow other host services; this must not fail when it does.
  const injected = []
  const ctx = {
    inject: (services, body) => {
      injected.push([...services])
      body(webCtx)
    },
  }

  host.apply(ctx)
  assert.ok(
    injected.some((names) => names.includes('webServer')),
    'the board route is registered on the web server',
  )
  assert.equal(routes.length, 1, 'exactly one route')
  assert.equal(routes[0].path, '/dsh-atc')
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

  const ok = await answer('/dsh-atc/data')
  assert.equal(ok.status, 200)
  assert.match(ok.headers['content-type'], /application\/json/)
  const board = JSON.parse(ok.body)
  assert.ok(Array.isArray(board.items), 'items is an array')
  assert.ok(Array.isArray(board.sources), 'sources is an array')
  assert.equal(typeof board.attention, 'number')
  assert.equal(typeof board.running, 'number')
  assert.equal(typeof board.total, 'number')
  assert.ok(Array.isArray(board.agents), 'agents is an array')
  for (const agent of board.agents) {
    assert.equal(typeof agent.tool, 'string')
    assert.equal(typeof agent.parsed, 'boolean')
    assert.equal(typeof agent.path, 'string')
    assert.equal(typeof agent.reason, 'string')
  }
  for (const source of board.sources) {
    assert.equal(typeof source.tool, 'string')
    assert.equal(typeof source.available, 'boolean')
  }
  for (const item of board.items) {
    assert.ok(
      ['dsh', 'codex', 'opencode', 'workbuddy', 'gemini', 'zcode', 'minimax', 'claude', 'trae'].includes(item.tool),
      `tool ${item.tool}`,
    )
    assert.equal(typeof item.workspace, 'string')
    assert.equal(typeof item.lastActivity, 'number')
    assert.ok(
      ['running', 'needs-you', 'failed', 'stopped', 'done', 'recent', 'idle'].includes(item.status),
      `status ${item.status}`,
    )
  }

  const miss = await answer('/dsh-atc/nope')
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
        assert.equal(loaded.id, 'dsh-atc')
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

test('client registers a sidebar row and its main panel page', () => {
  const definition = loadClient()
  assert.equal(definition.name, 'dsh-atc')
  // The surface is waited for inside `apply`, so the plugin declares no hard
  // dependency (a host without the sidebar must still boot).
  assert.deepEqual([...definition.inject], [])

  const slots = []
  const registry = {
    register: (options, component) => (slots.push({ options, component }), () => {}),
    inject: (ownerKey, body) => {
      body()
      return () => {}
    },
  }
  const ctx = {
    inject: (names, body) => {
      assert.deepEqual([...names], ['slots'])
      body({ slots: registry })
    },
  }

  definition.apply(ctx)

  assert.equal(slots.length, 2, 'sidebar row + main page registered')
  const row = slots.find((entry) => entry.options.name === 'sidebar.panellist')
  const panel = slots.find((entry) => entry.options.name === 'main')

  assert.ok(row, 'sidebar.panellist registered')
  assert.equal(row.options.id, 'atc')
  assert.equal(typeof row.options.label, 'function')
  assert.equal(row.options.label(), '空管')
  assert.equal(typeof row.component, 'function', 'icon is the second positional argument')

  assert.ok(panel, 'main panel registered')
  assert.equal(panel.options.key, 'atc')
  assert.equal(typeof panel.component, 'function')
})

test('every agent gets a mark of its own', async () => {
  const definition = loadClient()
  const { AGENT_GLYPH, agentGlyph } = definition.__test
  const { AGENT_CATALOG } = await import(pathToFileURL(join(root, 'lib', 'collect.mjs')).href)

  // Agents are told apart by shape, not by hue: two agents sharing a mark
  // would put them back where the colours had them. Agents we have no mark
  // for deliberately share the "unknown" ring.
  const tools = [...new Set(AGENT_CATALOG.map((entry) => entry.tool))]
  const seen = new Map()
  for (const tool of tools) {
    const mark = agentGlyph(tool)
    assert.ok(mark, `${tool} has a mark`)
    if (!AGENT_GLYPH[tool]) {
      assert.equal(mark, 'dashed', `${tool} falls back to the unknown ring`)
      continue
    }
    assert.equal(seen.has(mark), false, `${tool} shares the mark "${mark}" with ${seen.get(mark)}`)
    seen.set(mark, tool)
  }
  assert.ok(seen.size >= 8, 'the connected agents each own a mark')

  // An agent we have no mark for falls back to the "unknown" ring.
  assert.equal(agentGlyph('some-future-agent'), 'dashed')
})

test('a filter chip releases itself when picked twice', () => {
  const definition = loadClient()
  const { toggleFilter } = definition.__test

  // Picking a value that is not active selects it.
  assert.equal(toggleFilter('all', 'dsh'), 'dsh')
  assert.equal(toggleFilter('workbuddy', 'dsh'), 'dsh')
  // Picking the active value again clears it: a filter you cannot take off
  // again is a trap.
  assert.equal(toggleFilter('dsh', 'dsh'), 'all')
  assert.equal(toggleFilter('running', 'running'), 'all')
})

test('statusFromTurn trusts the turn boundaries over file age', async () => {
  const { statusFromTurn } = await import(pathToFileURL(join(root, 'lib', 'collect.mjs')).href)
  const now = Date.now()
  const recent = now - 60_000
  const old = now - 5 * 3600_000

  // A turn that started and has not ended is the only honest "running".
  assert.equal(statusFromTurn({ lastStart: recent, lastEnd: null }, old, now), 'running')
  assert.equal(
    statusFromTurn({ lastStart: now - 1000, lastEnd: { time: now - 2000, reason: 'completed' } }, old, now),
    'running',
  )
  // Ended reasons outrank age.
  assert.equal(statusFromTurn({ lastStart: old, lastEnd: { time: recent, reason: 'approval' } }, old, now), 'needs-you')
  assert.equal(statusFromTurn({ lastStart: old, lastEnd: { time: recent, reason: 'error' } }, old, now), 'failed')
  assert.equal(statusFromTurn({ lastStart: old, lastEnd: { time: recent, reason: 'abortedByUser' } }, old, now), 'stopped')
  // A plain completion means quiet now, so it decays instead of claiming running.
  assert.equal(statusFromTurn({ lastStart: old, lastEnd: { time: recent, reason: 'completed' } }, recent, now), 'recent')
  assert.equal(statusFromTurn({ lastStart: old, lastEnd: { time: old, reason: 'completed' } }, old, now), 'idle')
  // No turn facts at all: fall back to the age rule (which itself treats a
  // two-minute-old file as still running, by design).
  assert.equal(statusFromTurn({ lastStart: 0, lastEnd: null }, now - 5 * 60_000, now), 'recent')
  assert.equal(statusFromTurn({ lastStart: 0, lastEnd: null }, now - 30_000, now), 'running')
})
