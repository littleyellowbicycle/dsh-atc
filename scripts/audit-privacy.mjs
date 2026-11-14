/**
 * Pre-publish privacy audit: refuse to ship anything that describes this
 * machine instead of the plugin.
 *
 * The board reads other agents' local stores, so it is tempting to document
 * "on my box the file is 151 MB and starts with d2 ac 8b" — useful once, noise
 * (and a small leak) for everyone else. This fails the publish when such a
 * trace is present.
 *
 * `node scripts/audit-privacy.mjs` — exit 1 when something is found.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const TEXT_FILE = /\.(md|js|mjs|cjs|json|ya?ml|txt)$/i
const SKIP_DIR = new Set(['.git', 'node_modules', 'assets'])
// This file necessarily contains the patterns it looks for.
const SKIP_FILE = new Set(['package-lock.json', 'audit-privacy.mjs'])

/** The current user's home directory, both separators — the narrowest leak. */
const home = homedir()
const homeVariants = [home, home.replaceAll('\\', '/'), home.replaceAll('/', '\\')].filter(
  (value) => value.length > 3,
)

const RULES = [
  {
    id: 'home-path',
    why: '本机用户目录的绝对路径',
    test: (line) => homeVariants.some((value) => line.includes(value)),
  },
  {
    id: 'user-path',
    why: '其他机器的用户目录绝对路径',
    test: (line) => /[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'`]+/i.test(line) || /\/home\/[a-z0-9._-]+\//i.test(line),
  },
  {
    id: 'machine-claim',
    why: '描述"这台机器"的一次性状态',
    test: (line) => /这台机器|我这台|我的机器|on my machine/i.test(line),
  },
  {
    id: 'machine-artifact',
    why: '本机文件头 / 表名 / 体量细节',
    test: (line) => /SQLite format 3|ItemTable|\bd2 ac 8b\b|\b1[0-9]{2}\s?MB\b/i.test(line),
  },
  {
    id: 'secret',
    why: '看起来像密钥或访问令牌',
    test: (line) =>
      /\b(gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/.test(
        line,
      ),
  },
  {
    id: 'private-email',
    why: '个人邮箱',
    test: (line) => /\b[\w.+-]+@(qq|163|126|gmail|outlook|hotmail|foxmail)\.com\b/i.test(line),
  },
]

/** Every text file worth scanning, relative to the repo root. */
function collect(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIR.has(entry.name)) collect(join(dir, entry.name), out)
      continue
    }
    if (!entry.isFile() || SKIP_FILE.has(entry.name) || !TEXT_FILE.test(entry.name)) continue
    out.push(join(dir, entry.name))
  }
  return out
}

const findings = []
for (const file of collect(root, [])) {
  const shown = relative(root, file).replaceAll('\\', '/')
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, index) => {
    for (const rule of RULES) {
      if (!rule.test(line)) continue
      findings.push({ file: shown, line: index + 1, rule: rule.id, why: rule.why, text: line.trim().slice(0, 120) })
      break
    }
  })
}

if (findings.length === 0) {
  console.log(`privacy audit: clean (${collect(root, []).length} files scanned)`)
  process.exit(0)
}

console.error(`privacy audit: ${findings.length} 处需要脱敏\n`)
for (const finding of findings) {
  console.error(`  ${finding.file}:${finding.line}  [${finding.rule}] ${finding.why}`)
  console.error(`    ${finding.text}`)
}
console.error(`
修法：
  - 机器相关的体量 / 文件头 / 表名 → 只写"加密，读不到"这类结论
  - 个人绝对路径 → 写成 /path/to/... 或用环境变量
  - 一次性观察 → 移到本地笔记，不进仓库
`)
process.exit(1)
