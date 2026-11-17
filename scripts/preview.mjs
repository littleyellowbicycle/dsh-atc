/**
 * Render the board with a synthetic fixture and screenshot it.
 *
 * The picture that goes in the docs must not contain anyone's real sessions,
 * so this renders the real component against invented data — the layout, icons
 * and bands are genuine, the content is not. No blurring, no pixelating, and
 * nothing real leaks in the first place.
 *
 * `node scripts/preview.mjs [--width=1280] [--height=1000]`
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const ReactForBundle = await import('react')
const arg = (name, fallback) => {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`))
  return hit ? Number(hit.split('=')[1]) : fallback
}
const WIDTH = arg('width', 1280)
const HEIGHT = arg('height', 1020)

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
  if (!definition) throw new Error('client factory never ran')
  return definition
}

const MINUTE = 60_000
const now = Date.now()
const item = (tool, title, workspace, status, minutesAgo, detail = '') => ({
  tool,
  title,
  workspace,
  status,
  detail,
  lastActivity: now - minutesAgo * MINUTE,
  key: `${tool}-${minutesAgo}`,
})

/**
 * Invented sessions. Tool names stay real (the icons are the point); every
 * title, workspace and count below is made up for the screenshot.
 */
const items = [
  item('opencode', '附件上传大文件时进度条卡在 99%', 'D:/work/file-service', 'needs-you', 14, 'todo 2/5'),
  { ...item('dsh', '把日志采集改成批量写入', 'D:/work/log-pipeline', 'running', 0), doing: 'pwsh · 跑一次采集脚本的耗时对比' },
  { ...item('dsh', '给网关加一层请求重试', 'D:/work/gateway', 'running', 3), doing: 'write · src/gateway/retry.ts' },
  item('workbuddy', '每日站会纪要整理 09:00', 'WorkBuddy/2026-11-13', 'failed', 96),
  item('minimax', '竞品定价页的排版对比', 'D:/work/pricing-review', 'done', 22),
  item('codex', '升级构建脚本到 Node 24', 'D:/work/build-kit', 'stopped', 41),
  item('opencode', '把接口文档同步到 wiki', 'D:/work/api-docs', 'recent', 11),
  item('gemini', '把调研笔记整理成提纲', 'D:/notes/reading', 'idle', 1900),
  item('zcode', '重构配置加载顺序', 'D:/work/config-loader', 'idle', 2600),
  item('minimax', '把设计稿拆成组件清单', 'D:/work/design-split', 'idle', 3100),
  item('opencode', '补齐第 9 期的题库', 'D:/work/quiz', 'idle', 5400),
]

const tools = [...new Set(items.map((entry) => entry.tool))]
const tasks = tools.map((tool) => {
  const count = items.filter((entry) => entry.tool === tool).length
  return { tool, available: true, count, items: 0 }
})

const board = {
  generatedAt: now,
  sources: tasks,
  items,
  attention: 2,
  running: 2,
  total: 128,
  agents: tools.map((tool) => ({ tool, parsed: true, path: '', reason: '' })),
  discovery: { scannedAt: now, apps: 6, installable: 0, installableNames: [] },
}

const definition = loadClient()
definition.__test.store.data = board
definition.__test.store.at = now

const markup = renderToStaticMarkup(
  createElement(definition.__test.FleetPage, { ctx: { get: () => null } }),
)

const theme = `:root{
--dsw-alias-label-primary:#1b1d21;--dsw-alias-label-secondary:#4a5568;
--dsw-alias-label-tertiary:#6b7280;--dsw-alias-label-quaternary:#9aa3b2;
--dsw-alias-label-error:#c0392b;--dsw-alias-border-l1:#eceef1;
--dsw-alias-border-l2:#dfe3e8;--dsw-alias-separator-primary:#eceef1;
--dsw-alias-card-fill:#fafbfc;--dsw-alias-background-primary:#fff;
--dsw-alias-button-elevated-fill:#f4f5f7;--dsw-alias-interactive-bg-hover:#f2f4f7;
--dsw-alias-state-success-primary:#2f9e6f;--dsw-alias-state-warn-primary:#d98324;
--dsw-alias-state-error-primary:#c0392b;--dsw-alias-state-error-secondary:#f3c2bd;
--dsw-alias-state-business-primary:#7048e8;--dsw-alias-brand-primary:#4c6ef5}`

const page = `<!doctype html><meta charset="utf-8"><title>dsh-atc preview</title>
<script>
  window.addEventListener('load', () => {
    const page = document.querySelector('.fb-page')
    const height = Math.ceil((page ? page.getBoundingClientRect().height : document.body.scrollHeight) + 8)
    document.title = 'H=' + height
  })
</script>
<style>${theme}
html,body{margin:0;padding:0;background:#f6f7f9;color:#1b1d21;font-family:"Segoe UI Variable","Segoe UI",system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
/* The real panel fills a fixed-height host column; here the page is the column. */
.fb-page{height:auto!important;max-height:none!important}</style>
${markup}`

const docs = join(root, 'docs')
mkdirSync(docs, { recursive: true })
const htmlPath = join(docs, 'preview-board.html')
writeFileSync(htmlPath, page, 'utf8')

const edge = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((path) => existsSync(path))
if (!edge) {
  console.error('Edge not found — HTML written, screenshot skipped')
  process.exit(2)
}

// Pass 1: ask the browser how tall the page actually is.
const measured = spawnSync(
  edge,
  ['--headless=new', '--disable-gpu', '--window-size=1280,600', '--dump-dom', `file:///${htmlPath.replace(/\\/g, '/')}`],
  { encoding: 'utf8' },
)
const match = /<title>H=(\d+)<\/title>/.exec(measured.stdout ?? '')
const pageHeight = match ? Number(match[1]) : HEIGHT
console.log(`  measured page height: ${pageHeight}px`)

const pngPath = join(docs, 'preview-board.png')
const run = spawnSync(
  edge,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=2',
    `--window-size=${WIDTH},${pageHeight}`,
    `--screenshot=${pngPath}`,
    `file:///${htmlPath.replace(/\\/g, '/')}`,
  ],
  { encoding: 'utf8' },
)
if (run.status !== 0) {
  console.error(run.stderr || run.stdout)
  process.exit(run.status ?? 1)
}
const size = readFileSync(pngPath).length
console.log(`✓ docs/preview-board.html`)
console.log(`✓ docs/preview-board.png  (${WIDTH}×${pageHeight} @2x, ${Math.round(size / 1024)} kB)`)
console.log(`  ${items.length} synthetic sessions · ${tools.length} agents · no real data`)
