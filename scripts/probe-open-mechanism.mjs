/**
 * Prove the "open a terminal" mechanism without touching a real agent session.
 *
 * Mirrors `spawnPlan` exactly — write a .cmd, launch it with `cmd /c start ""` —
 * but the script writes a marker instead of running an agent, and `start /min`
 * keeps the console out of the way. Nothing is left on the desktop.
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const marker = join(tmpdir(), 'atc-open-mechanism.txt')
const script = join(tmpdir(), `atc-open-probe-${Date.now()}.cmd`)
rmSync(marker, { force: true })

// Same shape spawnPlan builds: cwd first, then the command, then the guard.
const body = [
  '@echo off',
  'cd /d "D:\\project\\dsh-atc"',
  `cd > "${marker}"`,
  `echo ok >> "${marker}"`,
  'if errorlevel 1 pause',
].join('\r\n')
writeFileSync(script, body + '\r\n', 'utf8')

const child = spawn('cmd.exe', ['/c', 'start', '', '/min', script], {
  detached: true,
  stdio: 'ignore',
})
let spawnError = null
child.on('error', (error) => {
  spawnError = error
})
child.unref()

await new Promise((resolve) => setTimeout(resolve, 2500))

let ok = true
if (spawnError) {
  console.log('✗ spawn 失败:', spawnError.message)
  ok = false
} else if (!existsSync(marker)) {
  console.log('✗ 子进程没有写出标记 —— start 链路不通')
  ok = false
} else {
  const content = readFileSync(marker, 'utf8').trim()
  const cwdHonoured = content.toLowerCase().includes('dsh-atc')
  console.log('✓ 终端被拉起，子进程写回了：')
  for (const line of content.split('\n').slice(0, 2)) console.log('   ' + line)
  console.log(cwdHonoured ? '✓ cwd 生效' : '✗ cwd 没生效')
  ok = cwdHonoured
}

rmSync(marker, { force: true })
rmSync(script, { force: true })
process.exit(ok ? 0 : 1)
