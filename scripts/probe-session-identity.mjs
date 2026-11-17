/**
 * Are these two DSH session directories actually the same conversation?
 *
 * The board shows them as two cards with the same title, workspace, status and
 * second. This reads each log and compares content, not names: if they are the
 * same session written twice, the event streams will agree; if they are two
 * runs of the same prompt, they will diverge early.
 */

import { closeSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { frameOffsets, eventsOfFrame } from '../lib/dsh-frames.mjs'

const root = join(homedir(), '.dsh', 'sessions')
const [, , ...ids] = process.argv

function locate(id) {
  for (const ws of readdirSync(root)) {
    const dir = join(root, ws, id)
    try {
      statSync(dir)
      return join(dir, 'session.v4.jsonl.zstd')
    } catch {
      /* keep looking */
    }
  }
  return null
}

function head(file, bytes = 64 * 1024) {
  const size = statSync(file).size
  const length = Math.min(size, bytes)
  const buffer = Buffer.alloc(length)
  const fd = openSync(file, 'r')
  try {
    readSync(fd, buffer, 0, length, 0)
  } finally {
    closeSync(fd)
  }
  const events = []
  for (const at of frameOffsets(buffer).slice(0, 40)) {
    for (const event of eventsOfFrame(buffer, at)) {
      events.push(event)
      if (events.length >= 60) return events
    }
  }
  return events
}

const summaries = []
for (const id of ids) {
  const file = locate(id)
  if (!file) {
    console.log(`${id}: 找不到`)
    continue
  }
  const size = statSync(file).size
  const events = head(file)
  const firstUser = events.find((event) => event.type === 'user/message')
  const firstPrompt = JSON.stringify(firstUser?.data ?? {}).slice(0, 160)
  const session = events.find((event) => event.type === 'session')
  const title = events.filter((event) => event.type === 'session/title').map((event) => event.data?.title)
  summaries.push({
    id,
    size,
    firstSeq: events[0]?.seq,
    maxSeq: Math.max(...events.map((event) => event.seq ?? 0)),
    createdAt: session?.data?.createdAt ?? session?.time ?? null,
    idInLog: session?.data?.id ?? '',
    title,
    firstPrompt,
  })
}

for (const summary of summaries) {
  console.log(`\n=== ${summary.id} ===`)
  console.log(`  大小 ${(summary.size / 1024).toFixed(1)} kB`)
  console.log(`  日志内 id: ${summary.idInLog}`)
  console.log(`  创建时间: ${summary.createdAt ? new Date(summary.createdAt).toLocaleString('zh-CN') : '?'}`)
  console.log(`  标题事件: ${JSON.stringify(summary.title)}`)
  console.log(`  首条用户消息: ${summary.firstPrompt}`)
}

if (summaries.length === 2) {
  const [a, b] = summaries
  const sameLogId = a.idInLog !== '' && a.idInLog === b.idInLog
  const samePrompt = a.firstPrompt === b.firstPrompt
  const sameSize = a.size === b.size
  console.log('\n=== 判定 ===')
  console.log(`  日志内会话 id 相同: ${sameLogId}   (${a.idInLog} vs ${b.idInLog})`)
  console.log(`  首条用户消息相同: ${samePrompt}`)
  console.log(`  文件大小相同: ${sameSize} (${a.size} vs ${b.size})`)
  console.log(
    sameLogId
      ? '  → 同一个会话被写进了两个目录'
      : '  → 两条不同会话，只是标题/时间撞在一起',
  )
}
