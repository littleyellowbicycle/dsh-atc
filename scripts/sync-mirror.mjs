/**
 * Mirror the published npm tarball into the gitcode sync repo.
 *
 * The isolated side cannot reach the npm registry, so it needs the exact bytes
 * that npm published — repacking with `npm pack` changes the checksums. This
 * downloads `dist.tarball` straight from the registry, verifies it against the
 * registry's own sha512/sha1, drops it under `packages/<name>-<version>/`, and
 * keeps that directory's README and the sync repo's index row in step.
 *
 * Usage:
 *   node scripts/sync-mirror.mjs                    # mirror, commit, push
 *   node scripts/sync-mirror.mjs --no-push          # mirror + commit only
 *   node scripts/sync-mirror.mjs --dry-run          # say what it would do
 *   node scripts/sync-mirror.mjs --version 0.17.0   # mirror a specific version
 *   node scripts/sync-mirror.mjs --repo D:/path/to/blueyellow-sync
 *
 * Defaults to the repo path in $DSH_ATC_SYNC_REPO, then
 * D:/project/mem_pool/blueyellow-sync.
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const name = manifest.name
const version = option('version', manifest.version)
const syncRepo = resolve(option('repo', process.env.DSH_ATC_SYNC_REPO ?? 'D:/project/mem_pool/blueyellow-sync'))
const dryRun = flag('dry-run')

const say = (message) => console.log(message)
const fail = (message) => {
  console.error(`\n✗ ${message}`)
  process.exit(1)
}

/* ---------------------------------------------------------------- git ----- */

function git(args, options = {}) {
  return execFileSync('git', args, { cwd: syncRepo, encoding: 'utf8', ...options }).trim()
}

function requireCleanSyncRepo() {
  if (!existsSync(join(syncRepo, '.git'))) fail(`${syncRepo} is not a git checkout`)
  const dirty = git(['status', '--porcelain'])
  if (dirty !== '') fail(`sync repo has uncommitted changes:\n${dirty}`)

  const behind = git(['rev-list', '--count', 'HEAD..@{u}']).trim()
  if (behind !== '0') fail(`sync repo is ${behind} commit(s) behind its remote — run git pull --rebase first`)
}

/* ------------------------------------------------------------ registry ---- */

async function fetchPublished(version) {
  const metaResponse = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`)
  if (!metaResponse.ok) fail(`registry metadata request failed: HTTP ${metaResponse.status}`)
  const meta = await metaResponse.json()
  const published = meta.versions?.[version]
  if (!published) {
    const known = Object.keys(meta.versions ?? {}).join(', ')
    fail(`${name}@${version} is not on the registry. published: ${known}`)
  }
  return { meta, published }
}

/* ---------------------------------------------------------------- files --- */

function sha(file, algorithm, encoding) {
  return createHash(algorithm).update(readFileSync(file)).digest(encoding)
}

function writeMirrorReadme({ dir, file, version, sha256, sha1, sizeKb, tarballUrl, releaseUrl }) {
  const body = `# ${name} ${version}（离线包）

Agent 空管中心（\`${name}\`）是一个 DeepSeek Harness 插件：在**左侧栏**加一行「空管」，点开是一屏面板，列出本机所有 agent 的会话（DSH / codex / opencode / WorkBuddy / Gemini / ZCode / MiniMax），按注意力排序。零 token、不联网、只读本地存储。

这个目录是为了让**没有 npm 凭据或访问不到 registry 的隔离网络**也能装上它。

## 文件

| 文件 | 大小 | SHA-256 |
|---|---|---|
| \`${file}\` | ${sizeKb} kB | \`${sha256}\` |

\`SHA-1: ${sha1}\`

校验（Windows）：

\`\`\`powershell
Get-FileHash .\\${file} -Algorithm SHA256
\`\`\`

## 来源

- npm：\`${tarballUrl}\`（本目录的文件就是它，sha512/sha1 均与 registry 元数据一致）
- GitHub：\`${releaseUrl}\`

不 clone 也能直接下这一个文件（实测 206，可断点续传）：

\`\`\`powershell
Invoke-WebRequest -Uri 'https://gitcode.com/littleyellowbicycle/blueyellow-sync/raw/main/packages/${name}-${version}/${file}' -OutFile ${file}
\`\`\`

\`raw.gitcode.com/<owner>/<repo>/main/<path>\` 是另一种写法。注意别用 \`raw.gitcode.com/.../raw/main/...\`（多一段 \`/raw/\` 会 403）。

## 安装

### 有 registry 访问

\`\`\`powershell
dsh plugin add ${name}@${version}
\`\`\`

### 离线：从本目录的 tgz 装

\`\`\`powershell
# 先 clone 本仓库，进到本目录
dsh plugin add <本目录的绝对路径>/${file}
\`\`\`

实测可用（\`dsh plugin add\` 接受本地 tgz 绝对路径，内部走 pnpm 的 file 依赖）。装完重启 DSH，左侧栏出现「空管」。

### 离线：手改 profile

\`~/.dsh/profiles/<profile>/package.json\`：

\`\`\`json
{
  "dependencies": { "${name}": "file:./${file}" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "${name}"] } }
}
\`\`\`

把 tgz 放到该 profile 目录下，然后用 DSH runtime 自带的 pnpm 安装（别用系统 pnpm，版本不匹配会报 lockfile 错误）：

\`\`\`powershell
$rt = "$env:USERPROFILE\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies"
cd "$env:USERPROFILE\\.dsh\\profiles\\<profile>"
& "$rt\\node\\bin\\node.exe" "$rt\\pnpm\\bin\\pnpm.cjs" install
\`\`\`

## 两个坑

- **npm 上还有一个 \`0.0.0-stage\`**：那是首次发布时 staged publishing 留下的占位版本，真实版本上传后 \`latest\` 已指向正式版，不用管它，也不要装它。
- **\`desktop\` profile 由桌面应用独占管理**，CLI 的 \`dsh plugin\` 改不了它。桌面端请在「插件 → 添加插件」里操作。

## 更新

新版发布后由 \`dsh-atc\` 仓库的 \`scripts/sync-mirror.mjs\` 生成新目录，别覆盖旧目录（隔离区可能在不同时间拉取）。
`
  if (dryRun) {
    say(`  would write ${join(dir, 'README.md')}`)
    return
  }
  writeFileSync(join(dir, 'README.md'), body)
}

/** Add or refresh this version's row in the sync repo index, in place. */
function updateIndexRow({ version, sizeKb, headline }) {
  const indexPath = join(syncRepo, 'README.md')
  const index = readFileSync(indexPath, 'utf8')
  const row = `| [\`packages/${name}-${version}/\`](packages/${name}-${version}/README.md) | ${headline} | ${new Date().toISOString().slice(0, 10)} |`
  const linePattern = new RegExp(`^\\| \\[\`packages/${name}-${version.replace(/\./g, '\\.')}/\`\\].*$`, 'm')

  let next
  if (linePattern.test(index)) {
    next = index.replace(linePattern, row)
    say('  index row updated')
  } else {
    const lines = index.split('\n')
    const lastRow = lines.reduce((found, line, i) => (line.startsWith('| [') ? i : found), -1)
    if (lastRow === -1) fail('could not find the index table in the sync repo README')
    lines.splice(lastRow + 1, 0, row)
    next = lines.join('\n')
    say('  index row added')
  }
  if (dryRun) return
  writeFileSync(indexPath, next)
}

/* ---------------------------------------------------------------- main ---- */

async function main() {
  say(`${name}@${version} → ${syncRepo}`)
  if (!dryRun) requireCleanSyncRepo()

  const { meta, published } = await fetchPublished(version)
  const tarballUrl = published.dist.tarball
  say(`  registry: ${tarballUrl}`)

  const dir = join(syncRepo, 'packages', `${name}-${version}`)
  const file = `${name}-${version}.tgz`
  const target = join(dir, file)

  let bytes
  if (existsSync(target)) {
    bytes = readFileSync(target)
    say('  tarball already present, re-verifying')
  } else {
    const response = await fetch(tarballUrl)
    if (!response.ok) fail(`tarball download failed: HTTP ${response.status}`)
    bytes = Buffer.from(await response.arrayBuffer())
    if (dryRun) say(`  would write ${target} (${(bytes.length / 1024).toFixed(1)} kB)`)
  }

  const expected512 = String(published.dist.integrity).replace(/^sha512-/, '')
  const actual512 = createHash('sha512').update(bytes).digest('base64')
  if (actual512 !== expected512) fail(`sha512 mismatch — refusing to mirror\n  got      ${actual512}\n  expected ${expected512}`)

  const sha1 = createHash('sha1').update(bytes).digest('hex')
  if (sha1 !== published.dist.shasum) fail(`sha1 mismatch — refusing to mirror`)

  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const sizeKb = Number((bytes.length / 1024).toFixed(1))
  say(`  verified: sha512 ok · sha256 ${sha256.slice(0, 16)}… · ${sizeKb} kB`)

  if (!dryRun) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(target, bytes)
  }

  writeMirrorReadme({
    dir,
    file,
    version,
    sha256,
    sha1,
    sizeKb,
    tarballUrl,
    releaseUrl: `${String(manifest.repository?.url ?? '').replace(/^git\+/, '').replace(/\.git$/, '')}/releases/tag/v${version}`,
  })

  const description = manifest.description ?? ''
  updateIndexRow({
    version,
    sizeKb,
    headline: `DSH 插件 \`${name}\`（Agent 空管中心）${version} 的离线安装包：npm 发布产物原样镜像 + SHA-256，供访问不到 registry 的隔离区直接用 tgz 安装`,
  })

  if (dryRun) {
    say('\n(dry run — nothing written, nothing committed)')
    return
  }

  git(['add', '-A'])
  const staged = git(['status', '--porcelain'])
  if (staged === '') {
    say('\nnothing to commit — the mirror is already up to date')
    return
  }
  git(['commit', '-m', `docs: 新增 ${name} ${version} 离线安装包\n\n由 dsh-atc/scripts/sync-mirror.mjs 生成：tgz 取自 registry 的 dist.tarball，\nsha512 与 registry 元数据核对一致。`])
  say(`  committed: ${git(['log', '--oneline', '-1'])}`)

  if (flag('no-push')) {
    say('\n--no-push: commit left local')
    return
  }
  git(['push', 'origin', 'HEAD'])
  say('  pushed')
}

await main()
