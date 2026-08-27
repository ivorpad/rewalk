#!/usr/bin/env node
// The hook entrypoint, kept deliberately small.
//
// This runs before and after every tool call of every agent session on this
// machine, so its cost is everybody's cost. It imports three node builtins
// through lib/hub-wire.mjs and asks a unix socket whether anything is waiting;
// the renderer is loaded lazily and only when there is something to render,
// which is the uncommon case.
//
// Everything swallows its errors. A hook that raises wedges the agent it was
// meant to help, so a hub that is down, a stale socket, and a hub mid-restart
// must all look exactly like "nothing waiting".
//
//   rewalk-hook register [--gone]     SessionStart / SessionEnd
//   rewalk-hook drain [--stop]        PostToolUse / Stop
import { hubCall, ensureHub } from '../lib/hub-wire.mjs'

const STOP_EVENTS = new Set(['Stop', 'stop', 'SubagentStop', 'turn_end'])
const BUSY_EVENTS = new Set(['PostToolUse', 'post_tool_use', 'PreToolUse', 'pre_tool_use'])

/** @returns {Promise<any>} */
async function hookInput() {
  if (process.stdin.isTTY) return {}
  try {
    /** @type {Buffer[]} */
    const chunks = []
    for await (const c of process.stdin) chunks.push(Buffer.from(c))
    const raw = Buffer.concat(chunks).toString('utf8')
    return raw.trim() ? JSON.parse(raw) : {}
  } catch (e) { return {} }
}

/** The session's own name, so the picker shows what the terminal shows.
 * Only infrequent events pay for this read. @param {string} p */
async function titleFromTranscript(p) {
  if (!p) return ''
  try {
    const fs = await import('node:fs')
    const size = fs.statSync(p).size
    const limit = 96 * 1024
    const fd = fs.openSync(p, 'r')
    const len = Math.min(size, limit)
    const buf = Buffer.alloc(len)
    fs.readSync(fd, buf, 0, len, Math.max(0, size - len))
    fs.closeSync(fd)
    let title = ''
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.includes('"title"')) continue
      try { const v = JSON.parse(line).title; if (typeof v === 'string' && v.trim()) title = v.trim() } catch (e) {}
    }
    return title.split(/\s+/).join(' ').slice(0, 60)
  } catch (e) { return '' }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2)
  if (!command) return 0
  const opts = { stop: rest.includes('--stop'), gone: rest.includes('--gone'), max: 4 }
  const maxAt = rest.indexOf('--max')
  if (maxAt >= 0 && rest[maxAt + 1]) opts.max = Number(rest[maxAt + 1]) || 4

  const payload = await hookInput()
  const event = String(payload.hook_event_name ?? payload.event ?? '')
  const cwd = String(payload.cwd ?? process.cwd())
  const sessionId = String(payload.session_id ?? payload.conversation_id ?? '')
  if (!sessionId) return 0
  const slug = BUSY_EVENTS.has(event) ? '' : await titleFromTranscript(String(payload.transcript_path ?? ''))
  const who = {
    session_id: sessionId,
    cwd,
    slug: slug || cwd.replace(/\/$/, '').split('/').pop() || cwd,
    agent: payload.conversation_id ? 'codex' : 'claude',
    pid: process.ppid,
    event,
  }

  if (command === 'register') {
    if (opts.gone) await hubCall('session-gone', { session_id: sessionId })
    else { await ensureHub(); await hubCall('session', { session: who }) }
    return 0
  }
  if (command !== 'drain') return 0

  const stopping = opts.stop || STOP_EVENTS.has(event)
  // Set by the harness while it is already re-entering because of an earlier
  // block. Blocking again on that pass is an infinite loop.
  if (stopping && payload.stop_hook_active) return 0

  const res = await hubCall('claim', { session: who, max: opts.max })
  const comments = /** @type {any[]} */ (res?.comments ?? [])
  if (!comments.length) return 0

  const { renderAll } = await import('../lib/comment.mjs')
  const text = renderAll(comments)
  const out = stopping
    ? { decision: 'block', reason: text }
    : { hookSpecificOutput: { hookEventName: event || 'PostToolUse', additionalContext: text },
        systemMessage: `rewalk: ${comments.length} comment(s) delivered` }

  // Ack only after the write lands. A claim that is never acked has its lease
  // expire and returns to the queue — the fix for messages that vanished when
  // a hook died between claiming and printing.
  process.stdout.write(JSON.stringify(out))
  await new Promise((r) => (process.stdout.write('') ? r(undefined) : process.stdout.once('drain', r)))
  await hubCall('ack', { ids: comments.map((c) => c.id) })
  return 0
}

main().then((c) => process.exit(c ?? 0)).catch(() => process.exit(0))
