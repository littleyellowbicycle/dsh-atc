/**
 * Bringing an already-running tool to the front.
 *
 * The board's job ends at "which session is this"; the tool that owns the
 * session is usually already open somewhere on the desktop, and the useful
 * action is to show that window — not to start a second client on a session the
 * first one is still holding.
 *
 * There is no Win32 binding in Node, so this goes through one PowerShell run that
 * does the enumeration and the focus. It is slower than an in-process call
 * (~300–600 ms) and only runs when a card is clicked.
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The PowerShell half.
 *
 * `SetForegroundWindow` only works for the process Windows considers allowed to
 * take the foreground, so the script attaches to the current foreground thread
 * first — that is the documented workaround, and without it the call silently
 * does nothing while DSH itself is in front.
 *
 * Two criteria are ANDed when both are given, so a matcher can require "title
 * says opencode" *and* "the window belongs to a console host".
 */
const SCRIPT = `param([string]$Mode = 'list', [string]$Title = '', [string]$Proc = '')

# The host reads stdout as UTF-8; without this Windows hands back the console
# code page and every non-ASCII window title arrives as mojibake.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class AtcWin {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(int a, int b, bool attach);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool alt);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
  [DllImport("kernel32.dll")] public static extern int GetCurrentThreadId();
  public delegate bool EnumProc(IntPtr h, IntPtr p);
}
"@

$found = New-Object System.Collections.ArrayList
$cb = [AtcWin+EnumProc]{
  param($hWnd, $lParam)
  if (-not [AtcWin]::IsWindowVisible($hWnd)) { return $true }
  $len = [AtcWin]::GetWindowTextLength($hWnd)
  if ($len -le 0) { return $true }
  $sb = New-Object System.Text.StringBuilder ($len + 2)
  [void][AtcWin]::GetWindowText($hWnd, $sb, $sb.Capacity)
  $windowPid = 0
  [void][AtcWin]::GetWindowThreadProcessId($hWnd, [ref]$windowPid)
  $procName = '?'
  try { $procName = (Get-Process -Id $windowPid -ErrorAction Stop).ProcessName } catch { }
  [void]$found.Add([pscustomobject]@{
    hwnd = [int64]$hWnd; pid = $windowPid; proc = $procName; title = $sb.ToString()
  })
  return $true
}
[void][AtcWin]::EnumWindows($cb, [IntPtr]::Zero)

if ($Mode -eq 'list') {
  $found | ConvertTo-Json -Compress -Depth 3
  exit 0
}

$match = $found | Where-Object {
  (($Title -eq '') -or ($_.title -match $Title)) -and (($Proc -eq '') -or ($_.proc -match $Proc))
} | Select-Object -First 1

if (-not $match) { '{"ok":false,"reason":"no-window"}'; exit 0 }

$hwnd = [IntPtr]$match.hwnd
$before = [AtcWin]::GetForegroundWindow()
[void][AtcWin]::ShowWindow($hwnd, 9)

# Windows refuses SetForegroundWindow for a process the user is not currently
# interacting with, which is exactly the case right after a click lands in DSH.
# Three escalating attempts; each one is verified by reading the foreground
# window back, so "requested" never gets confused with "happened".
function Raise([IntPtr]$h) {
  $fg = [AtcWin]::GetForegroundWindow()
  $fgThread = [AtcWin]::GetWindowThreadProcessId($fg, [ref]$null)
  $myThread = [AtcWin]::GetCurrentThreadId()
  [void][AtcWin]::AttachThreadInput($myThread, $fgThread, $true)
  $ok = [AtcWin]::SetForegroundWindow($h)
  [void][AtcWin]::AttachThreadInput($myThread, $fgThread, $false)
  return $ok
}

$ok = Raise $hwnd
Start-Sleep -Milliseconds 120
$now = [AtcWin]::GetForegroundWindow()

if ($now -ne $hwnd) {
  # SwitchToThisWindow predates the foreground lock and is not subject to it.
  [AtcWin]::SwitchToThisWindow($hwnd, $true)
  Start-Sleep -Milliseconds 120
  $now = [AtcWin]::GetForegroundWindow()
}

if ($now -ne $hwnd) {
  # Last resort: a synthetic ALT tap is what unlocks SetForegroundWindow for
  # the calling process. Harmless when it does not help.
  [AtcWin]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
  [AtcWin]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  $ok = Raise $hwnd
  Start-Sleep -Milliseconds 120
  $now = [AtcWin]::GetForegroundWindow()
}

[pscustomobject]@{
  ok = ($now -eq $hwnd); requested = $ok; title = $match.title; proc = $match.proc; pid = $match.pid
} | ConvertTo-Json -Compress
`

function run(args) {
  if (process.platform !== 'win32') return null
  const dir = mkdtempSync(join(tmpdir(), 'dsh-atc-win-'))
  const file = join(dir, 'windows.ps1')
  try {
    writeFileSync(file, SCRIPT, 'utf8')
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, ...args],
      { encoding: 'utf8', timeout: 15_000, windowsHide: true },
    )
    if (result.status !== 0 || !result.stdout) return null
    return result.stdout.trim()
  } catch {
    return null
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* a leftover temp dir is not worth failing the click */
    }
  }
}

/** Every visible top-level window, for diagnostics and for finding a match. */
export function listWindows() {
  const raw = run(['-Mode', 'list'])
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return []
  }
}

/**
 * Bring the first window matching a title pattern and/or a process pattern to
 * the front.
 *
 * @param title - regex tested against the window title.
 * @param proc - regex tested against the window's process name.
 * @returns `{ ok, title, proc }` when it actually reached the foreground,
 *   `{ ok:false, reason }` otherwise. The `ok` is verified by re-reading the
 *   foreground window, not taken from SetForegroundWindow's return value.
 */
export function focusWindow({ title = '', proc = '' } = {}) {
  if (!title && !proc) return { ok: false, reason: 'no-criteria' }
  const raw = run(['-Mode', 'focus', '-Title', title, '-Proc', proc])
  if (!raw) return { ok: false, reason: 'unavailable' }
  try {
    return JSON.parse(raw)
  } catch {
    return { ok: false, reason: 'unparsable' }
  }
}

/**
 * Only console hosts count for the CLI tools.
 *
 * Without this, a browser tab whose title happens to contain "OpenCode" wins the
 * match and the click steals focus to Edge instead of the terminal — observed on
 * this machine with a real Edge window before the allowlist existed.
 */
const TERMINAL_HOSTS = '^(cmd|conhost|WindowsTerminal|powershell|pwsh|wt|Code)$'

/** How to find each tool's window: title pattern, process pattern, or both. */
export const WINDOW_MATCHERS = {
  workbuddy: { proc: '^WorkBuddy$' },
  opencode: { title: 'opencode', proc: TERMINAL_HOSTS },
  codex: { title: 'codex', proc: TERMINAL_HOSTS },
  zcode: { proc: '^ZCode$' },
  trae: { proc: '^Trae CN$' },
}

/** Which tools can be brought to the front, for the UI to describe the click. */
export function focusableTools() {
  return Object.keys(WINDOW_MATCHERS)
}
