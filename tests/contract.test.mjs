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

test('every state gets a mark of its own', async () => {
  const definition = loadClient()
  const { STATUS_SHAPES, STATUS_ORDER } = definition.__test

  // Two states sharing a mark would put them back where the colours had
  // them: colour alone cannot carry seven states.
  const seen = new Map()
  for (const status of STATUS_ORDER) {
    const shape = STATUS_SHAPES[status]
    assert.ok(shape, `${status} has a mark`)
    const key = JSON.stringify(shape)
    assert.equal(seen.has(key), false, `${status} shares its mark with ${seen.get(key)}`)
    seen.set(key, status)
  }
})

test('rows that share a title get a short id, only within one day', async () => {
  const { shortSessionId, markDuplicateTitles } = await import(
    pathToFileURL(join(root, 'lib', 'rules.mjs')).href
  )

  const noon = new Date('2026-11-16T12:00:00').getTime()
  const nextDay = noon + 86_400_000

  // Two sessions, same prompt, same second — the case that prompted this.
  const pair = [
    { tool: 'dsh', title: '你是独立评分员', workspace: 'w', lastActivity: noon, sessionId: 'session-9015d1a7-7084-4213' },
    { tool: 'dsh', title: '你是独立评分员', workspace: 'w', lastActivity: noon, sessionId: 'session-9adb5f20-3c1e-4c82' },
  ]
  assert.equal(markDuplicateTitles(pair), 2)
  assert.equal(pair[0].disambiguator, '4213')
  assert.equal(pair[1].disambiguator, '4c82')
  assert.notEqual(pair[0].disambiguator, pair[1].disambiguator)

  // Same title on different days: the date line already distinguishes them, so
  // no id — otherwise every daily automation would collect one.
  const daily = [
    { tool: 'workbuddy', title: '每日自动签到', workspace: 'w', lastActivity: noon, key: 'a7fb367c-1111' },
    { tool: 'workbuddy', title: '每日自动签到', workspace: 'w', lastActivity: nextDay, key: '4dc00b3f-2222' },
  ]
  assert.equal(markDuplicateTitles(daily), 0)
  assert.equal(daily[0].disambiguator, undefined)

  // A unique title stays clean.
  const single = [{ tool: 'dsh', title: '只有一个', workspace: 'w', lastActivity: noon, sessionId: 'session-1' }]
  assert.equal(markDuplicateTitles(single), 0)

  // The suffix is the id's tail, not the file extension.
  assert.equal(shortSessionId({ sessionId: 'session-c0520b56-1111-2222' }), '2222')
  assert.equal(shortSessionId({ openId: 'ses_e1cd4e6c8ffe' }), '8ffe')
  assert.equal(
    shortSessionId({ key: 'C:/x/.gemini/tmp/p/chats/session-2026-05-09T03-24-97ab3090.json' }),
    '3090',
  )
})

test('the detail drawer pairs calls with results across frames', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join: joinPath } = await import('node:path')
  const { zstdCompressSync } = await import('node:zlib')
  const { readDshDetail } = await import(pathToFileURL(join(root, 'lib', 'detail.mjs')).href)

  // A log is a run of independent frames, and a call and its result land in
  // different ones — that is the case the reader has to survive.
  const frame = (events) => zstdCompressSync(Buffer.from(events.map((e) => JSON.stringify(e)).join('\n') + '\n'))
  const log = Buffer.concat([
    frame([
      { type: 'session/title', time: 1000, data: { title: 'x' } },
      {
        type: 'tool/call',
        time: 2000,
        data: { callId: 'c1', name: 'pwsh', arguments: JSON.stringify({ description: '跑个探测' }) },
      },
    ]),
    frame([
      {
        type: 'tool/result',
        time: 2450,
        data: {
          toolCallId: 'c1',
          message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'text', text: 'ok' }] },
        },
      },
      {
        type: 'assistant/message',
        time: 2500,
        data: { message: { role: 'assistant' }, usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } },
      },
    ]),
    frame([
      {
        type: 'tool/call',
        time: 3000,
        data: { callId: 'c2', name: 'present', arguments: JSON.stringify({ path: 'D:/a.png' }) },
      },
      { type: 'turn/end', time: 3100, data: { reason: { kind: 'completed' } } },
    ]),
  ])

  const dir = mkdtempSync(joinPath(tmpdir(), 'atc-detail-'))
  const file = joinPath(dir, 'session.v4.jsonl.zstd')
  writeFileSync(file, log)

  const detail = readDshDetail(file)
  assert.equal(detail.supported, true)
  assert.equal(detail.calls.length, 2)
  assert.equal(detail.totalCalls, 2)

  // Newest first.
  assert.equal(detail.calls[0].callId, 'c2')
  assert.equal(detail.calls[0].target, 'D:/a.png')
  assert.equal(detail.calls[0].finished, false, 'no result yet — still running')
  assert.equal(detail.calls[0].durationMs, null)

  const paired = detail.calls[1]
  assert.equal(paired.callId, 'c1')
  assert.equal(paired.target, '跑个探测')
  assert.equal(paired.finished, true)
  assert.equal(paired.durationMs, 450, 'duration is result time minus call time')
  assert.equal(paired.snippet, 'ok')

  assert.equal(detail.usage.totalTokens, 30)
  assert.equal(detail.usage.inputTokens, 10)
  assert.equal(detail.lastTurn.reason, 'completed')
})

test('a running card says what the session is doing', async () => {
  const { callTarget, summarizeCall, doingLine } = await import(
    pathToFileURL(join(root, 'lib', 'tool-calls.mjs')).href
  )

  // The agent writes a human sentence for the tool when it can; that beats the
  // command line, which is what a person would have to parse.
  assert.equal(
    callTarget(JSON.stringify({ command: 'cd D:\\x; node y.mjs', description: '量一下开销' })),
    '量一下开销',
  )
  // Without a description, the file it is touching is the useful part.
  assert.equal(callTarget(JSON.stringify({ file_path: 'D:/p/a.ts', content: 'x' })), 'D:/p/a.ts')
  assert.equal(callTarget('{"command":"npm test"}'), 'npm test')
  // Nothing usable: empty, so the caller shows the tool name alone.
  assert.equal(callTarget('{}'), '')
  assert.equal(callTarget('not json'), '')
  // Bounded: a pasted blob must not become the card's subtitle.
  assert.ok(callTarget(JSON.stringify({ command: 'x'.repeat(400) })).length <= 121)

  const call = summarizeCall({
    type: 'tool/call',
    time: 1794817409874,
    data: { name: 'pwsh', arguments: JSON.stringify({ description: '跑个探测' }) },
  })
  assert.equal(call.name, 'pwsh')
  assert.equal(call.target, '跑个探测')
  assert.equal(doingLine(call), 'pwsh · 跑个探测')
  assert.equal(doingLine({ name: 'present', target: '' }), 'present', 'name alone when there is no target')
  assert.equal(summarizeCall({ type: 'turn/start' }), null, 'only tool calls summarise')
})

test('focus matchers name real tools and exclude browsers', async () => {
  const { WINDOW_MATCHERS, focusableTools } = await import(pathToFileURL(join(root, 'lib', 'focus.mjs')).href)

  for (const tool of ['workbuddy', 'opencode', 'codex', 'zcode', 'trae']) {
    assert.ok(WINDOW_MATCHERS[tool], `${tool} has a matcher`)
    assert.ok(focusableTools().includes(tool))
  }

  // Every pattern must compile — a broken regex would throw inside PowerShell.
  for (const [tool, criteria] of Object.entries(WINDOW_MATCHERS)) {
    for (const key of ['title', 'proc']) {
      if (criteria[key]) assert.doesNotThrow(() => new RegExp(criteria[key]), `${tool}.${key} compiles`)
    }
  }

  // The CLI tools require a console host: a browser tab titled "OpenCode Console"
  // must not win the match, which is what happened before the allowlist.
  const hosts = new RegExp(WINDOW_MATCHERS.opencode.proc)
  assert.equal(hosts.test('cmd'), true)
  assert.equal(hosts.test('WindowsTerminal'), true)
  assert.equal(hosts.test('msedge'), false)
  assert.equal(hosts.test('chrome'), false)
})

test('planOpen decides what a click runs, and refuses anything it cannot run', async () => {
  const { planOpen, openerLabels } = await import(pathToFileURL(join(root, 'lib', 'openers.mjs')).href)

  const opencode = planOpen({ tool: 'opencode', openId: 'ses_e1cd4e6c8ffea', cwd: 'D:/work/proj' })
  assert.equal(opencode.ok, true)
  assert.equal(opencode.command, 'opencode')
  assert.deepEqual([...opencode.args], ['-s', 'ses_e1cd4e6c8ffea'])
  assert.equal(opencode.cwd, 'D:/work/proj', 'an absolute cwd is carried through')

  const codex = planOpen({ tool: 'codex', openId: '01a132e3-d137-7e42-9ccb-3fccb69cedb8', cwd: 'C:\\work' })
  assert.deepEqual([...codex.args], ['resume', '01a132e3-d137-7e42-9ccb-3fccb69cedb8'])

  // A tool with no opener is a refusal, not a guess — the client then copies.
  assert.equal(planOpen({ tool: 'workbuddy', openId: 'abc' }).reason, 'no-opener')
  assert.equal(planOpen({ tool: 'dsh', openId: 'session-x' }).reason, 'no-opener')

  // Ids reach a command line, so anything shell-shaped is refused outright.
  for (const bad of ['', '  ', 'a b', 'x; rm -rf /', "a'b", '$(whoami)', 'a'.repeat(129)]) {
    assert.equal(planOpen({ tool: 'opencode', openId: bad }).reason, 'bad-id', 'refused: ' + bad)
  }

  // A relative cwd is dropped rather than passed to the terminal.
  assert.equal(planOpen({ tool: 'opencode', openId: 'abc', cwd: 'relative/dir' }).cwd, undefined)

  // Only tools with a real opener are advertised to the UI.
  assert.deepEqual(Object.keys(openerLabels()).sort(), ['codex', 'opencode'])
})

test('readSqliteSource reports rows, the store total, and its own failures', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join: joinPath } = await import('node:path')
  const { DatabaseSync } = await import('node:sqlite')
  const { readSqliteSource } = await import(pathToFileURL(join(root, 'lib', 'capabilities.mjs')).href)

  const dir = mkdtempSync(joinPath(tmpdir(), 'atc-cap-'))
  const store = joinPath(dir, 'store.db')
  const db = new DatabaseSync(store)
  db.exec('CREATE TABLE items (id TEXT, title TEXT, updated INTEGER)')
  const insert = db.prepare('INSERT INTO items VALUES (?, ?, ?)')
  for (let i = 0; i < 5; i += 1) insert.run('id' + i, 'title' + i, 1000 + i)
  db.close()

  const seen = []
  const result = await readSqliteSource({
    tool: 'demo',
    now: 42,
    conf: { perSource: 3 },
    candidates: [joinPath(dir, 'missing.db'), store],
    missing: 'no store',
    countSql: 'SELECT COUNT(*) AS n FROM items',
    rowSql: 'SELECT id, title, updated FROM items ORDER BY updated DESC LIMIT ?',
    map: (row, ctx) => {
      seen.push(ctx.now)
      return { tool: 'demo', title: row.title, lastActivity: row.updated, key: row.id }
    },
  })

  assert.equal(result.available, true)
  assert.equal(result.count, 5, 'count is the store total, not the page size')
  assert.equal(result.items.length, 3, 'rowSql honours perSource')
  assert.equal(seen.length, 3)
  assert.equal(seen[0], 42, 'the mapper receives now')
  assert.equal(result.items[0].key, 'id4', 'newest first')

  // No candidate on disk: one unavailable source, not a throw.
  const absent = await readSqliteSource({
    tool: 'demo',
    now: 0,
    conf: { perSource: 3 },
    candidates: [joinPath(dir, 'nothing.db')],
    missing: 'no store',
    countSql: 'SELECT COUNT(*) AS n FROM items',
    rowSql: 'SELECT * FROM items LIMIT ?',
    map: () => ({}),
  })
  assert.equal(absent.available, false)
  assert.equal(absent.reason, 'no store')

  // A broken query degrades the source instead of failing the board.
  const broken = await readSqliteSource({
    tool: 'demo',
    now: 0,
    conf: { perSource: 3 },
    candidates: [store],
    missing: 'no store',
    countSql: 'SELECT COUNT(*) AS n FROM items',
    rowSql: 'SELECT * FROM nope LIMIT ?',
    map: () => ({}),
  })
  assert.equal(broken.available, false)
  assert.ok(/nope/.test(String(broken.reason)), 'the reason names the failing query')
})

test('resolveTitle picks the same source the collectors used to pick by hand', async () => {
  const { resolveTitle, isPlaceholderTitle, toMs } = await import(
    pathToFileURL(join(root, 'lib', 'rules.mjs')).href
  )

  // A store-supplied name wins when it is a name.
  assert.equal(resolveTitle({ declared: 'Hosts 显存长测', fallback: 'abcd1234' }), 'Hosts 显存长测')
  // A store that writes placeholders loses to the first prompt.
  assert.equal(
    resolveTitle({
      declared: 'New session - 2026-08-07T03:22:44.509Z',
      prompt: '把接口文档同步到 wiki',
      fallback: 'abcd1234',
      distrustDeclared: true,
    }),
    '把接口文档同步到 wiki',
  )
  // With no prompt, even a placeholder beats "unknown" — that is what shipped.
  assert.equal(
    resolveTitle({
      declared: 'New session - 2026-08-07T03:22:44.509Z',
      fallback: 'abcd1234',
      distrustDeclared: true,
    }),
    'New session - 2026-08-07T03:22:44.509Z',
  )
  // Without the flag, a placeholder-shaped name is still a name (unchanged for
  // every other source).
  assert.equal(
    resolveTitle({ declared: 'New session - x', fallback: 'abcd1234' }),
    'New session - x',
  )
  // Nothing declared: the prompt, then the fallback.
  assert.equal(resolveTitle({ prompt: '第一句话', fallback: 'abcd1234' }), '第一句话')
  assert.equal(resolveTitle({ declared: '   ', fallback: 'abcd1234' }), 'abcd1234')

  assert.equal(isPlaceholderTitle(''), true)
  assert.equal(isPlaceholderTitle('New session - 2026-01-01'), true)
  // Only opencode's actual placeholder shape counts; a real name that merely
  // starts with the same letters must survive.
  assert.equal(isPlaceholderTitle('New sessions summary'), false)
  assert.equal(isPlaceholderTitle('未命名 · ab12'), false)

  // Seconds and milliseconds both land in epoch-ms; that guess is why stores do
  // not need a per-source unit rule.
  assert.equal(toMs(1794624896), 1794624896000)
  assert.equal(toMs(1794624896000), 1794624896000)
  assert.equal(toMs(null), 0)
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

test('a discovered store is read without any collector of its own', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join: joinPath } = await import('node:path')
  const { DatabaseSync } = await import('node:sqlite')
  const { collectBoard } = await import(pathToFileURL(join(root, 'lib', 'collect.mjs')).href)

  const dir = mkdtempSync(joinPath(tmpdir(), 'atc-discover-'))
  const store = joinPath(dir, 'made-up-agent.db')
  const db = new DatabaseSync(store)
  // Exactly the shape `opencode-like` describes, under a tool nobody wrote code for.
  db.exec('CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_updated INTEGER)')
  db.exec('CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER)')
  const now = Date.now()
  db.prepare('INSERT INTO session VALUES (?, ?, ?, ?)').run('s1', '自动接入的会话', 'D:/work/proj', now - 60_000)
  db.prepare('INSERT INTO message VALUES (?, ?, ?)').run('m1', 's1', now - 60_000)
  db.close()

  const board = await collectBoard([{ tool: 'madeup', store, specId: 'opencode-like' }])
  const rows = board.items.filter((item) => item.tool === 'madeup')
  assert.equal(rows.length, 1, 'the discovered store produced a row')
  assert.equal(rows[0].title, '自动接入的会话')
  assert.equal(rows[0].workspace, 'D:/work/proj')
  assert.equal(rows[0].auto, true, 'row is marked as discovered')

  // A store whose shape matches but whose columns are gone is skipped, not guessed.
  const wrong = await collectBoard([{ tool: 'broken', store, specId: 'runtime-state' }])
  assert.equal(wrong.items.filter((item) => item.tool === 'broken').length, 0)
})
