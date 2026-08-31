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

/** The session's own name — what the person renamed it to, which the harness
 * writes into the transcript as "title". Kept apart from the cwd basename by
 * the caller; only infrequent events pay for this read. @param {string} p */
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
  const title = BUSY_EVENTS.has(event) ? '' : await titleFromTranscript(String(payload.transcript_path ?? ''))
  const who = {
    session_id: sessionId,
    cwd,
    // The directory, and only ever the directory. This used to be where the
    // renamed title landed too, which meant nothing downstream could tell "the
    // person called this session payments" from "this session happens to live
    // in ~/src/payments" — and the picker had to guess.
    slug: cwd.replace(/\/$/, '').split('/').pop() || cwd,
    // What its owner renamed it to, when they did. Empty on busy events, which
    // do not pay for the transcript read, so the hub must keep the prior value
    // rather than let a tool call blank it.
    title,
    agent: payload.conversation_id ? 'codex' : 'claude',
    pid: process.ppid,
    // The terminal this session is sitting in, inherited straight from its own
    // environment. Nothing else can tell the hub which pane to nudge when a
    // comment arrives for a session that is idle — and an idle session fires no
    // hooks, so there is no later opportunity to find out. Absent unless the
    // person runs one of these, which is fine: waking is a bonus, not the
    // mechanism.
    pane: process.env.HERDR_PANE_ID ?? '',
    tmux_pane: process.env.TMUX_PANE ?? '',
    // $TMUX is "<socket path>,<pid>,<session>". The socket matters as much as
    // the pane: `tmux send-keys` addresses the DEFAULT server, and a pane from
    // a `tmux -L name` server simply does not exist there.
    tmux_socket: (process.env.TMUX ?? '').split(',')[0],
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
