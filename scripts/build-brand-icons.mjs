/**
 * Regenerate the brand marks inlined into `client/client.js`.
 *
 * The browser bundle cannot import anything but React, so the paths live in a
 * marked block instead of a dependency. `simple-icons` is a devDependency; run
 * `node scripts/build-brand-icons.mjs` after bumping it, or with `--check` to
 * verify the block is current.
 *
 * Tools with no published brand (codex, zcode, qoder, aider) are deliberately
 * absent: a made-up logo is worse than the geometric fallback.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as icons from 'simple-icons'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT = join(root, 'client', 'client.js')
const START = '// <brand-icons>'
const END = '// </brand-icons>'

/** Our tool id → simple-icons export name. Missing entries keep the fallback. */
const SLUGS = {
  dsh: 'siDeepseek',
  opencode: 'siOpencode',
  workbuddy: 'siCodebuddy',
  gemini: 'siGooglegemini',
  minimax: 'siMinimax',
  claude: 'siClaude',
  trae: 'siTrae',
  cursor: 'siCursor',
  windsurf: 'siWindsurf',
  qwen: 'siQwen',
}

const entries = []
for (const [tool, exportName] of Object.entries(SLUGS)) {
  const icon = icons[exportName]
  if (!icon) throw new Error(`simple-icons has no ${exportName} (needed for ${tool})`)
  entries.push([tool, { hex: `#${icon.hex}`.toUpperCase(), title: icon.title, path: icon.path }])
}

const body = entries
  .map(
    ([tool, icon]) =>
      `      ${tool}: { hex: '${icon.hex}', title: ${JSON.stringify(icon.title)}, path: '${icon.path}' },`,
  )
  .join('\n')

const block = `${START}
    /**
     * Real brand marks, one path each on a 24×24 viewBox. Generated from
     * simple-icons by \`scripts/build-brand-icons.mjs\` — do not hand-edit.
     * A tool absent here keeps its geometric glyph on purpose: no invented logo.
     */
    const BRAND_ICONS = {
${body}
    }
    ${END}`

const source = readFileSync(CLIENT, 'utf8')
const from = source.indexOf(START)
const to = source.indexOf(END)
if (from === -1 || to === -1) {
  console.error(`markers not found in ${CLIENT}`)
  process.exit(1)
}
const next = `${source.slice(0, from)}${block}${source.slice(to + END.length)}`

if (process.argv.includes('--check')) {
  if (next !== source) {
    console.error('brand icons are stale — run node scripts/build-brand-icons.mjs')
    process.exit(1)
  }
  console.log(`brand icons up to date (${entries.length} marks)`)
  process.exit(0)
}

writeFileSync(CLIENT, next)
console.log(`wrote ${entries.length} brand marks into client/client.js`)
