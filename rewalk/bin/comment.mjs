#!/usr/bin/env node
// rewalk comment — send a comment to a coding-agent session without a browser.
//
// The overlay is the normal producer of these; this verb exists so the
// envelope, the queue, the routing and the hook rendering can all be exercised
// (and tested) with no extension loaded and no page open. Same path, same
// validation, same queue.
//
//   rewalk comment --text "the drawer close does nothing" --node "#close"
//   rewalk comment --file envelope.json          (- for stdin)
//   rewalk comment --sessions                    who could receive one
//   rewalk comment --list                        what is queued
import fs from 'node:fs'
import { KIND, normalizeComment, renderComment } from '../lib/comment.mjs'
import { ensureHub, hubCall } from '../lib/hub-wire.mjs'
import { resolveSessionDir } from '../lib/config.mjs'

const argv = process.argv.slice(2)
/** @param {string} f */
const flag = (f) => argv.includes(f)
/** @param {string} f */
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined }
/** @param {string} f */
const all = (f) => argv.reduce((/** @type {string[]} */ acc, a, i) => (a === f && argv[i + 1] ? [...acc, argv[i + 1]] : acc), [])

const USAGE = `rewalk comment — send a comment to a coding-agent session

  --text <s>          what to say (required unless --file)
  --node <selector>   element the comment is about; repeatable
  --session <dir>     rewalk session directory whose artifacts back this
  --recording         that session is still recording: hold until it finishes
  --url <url>         page the comment was written on
  --to <session_id>   deliver to exactly this session (see --sessions)
  --cwd <dir>         route by directory when no --to is given (default: cwd)
  --file <path>       read a whole envelope as JSON ("-" for stdin)
  --sessions          list sessions that could receive a comment
  --list              list queued comments, and why each is still waiting
  --retarget <id> --to <session>   send a queued comment to a different session
  --untarget <id>     drop a comment's chosen session; route it by directory
                      instead (for one aimed at a session that will never
                      claim it — e.g. started before the hooks were installed)
  --render            print what the agent would see, do not send
`

if (flag('-h') || flag('--help') || !argv.length) { console.log(USAGE); process.exit(argv.length ? 0 : 1) }

if (flag('--sessions')) {
  await ensureHub()
  const r = await hubCall('sessions', {})
  const sessions = /** @type {any[]} */ (r?.sessions ?? [])
  if (!sessions.length) { console.log('no live agent sessions'); process.exit(1) }
  for (const s of sessions)
    console.log(`${s.session_id.padEnd(38)} ${String(s.agent).padEnd(7)} ${String(s.pane_name || s.slug).padEnd(34)} ` +
      `${String(s.agent_status ?? '').padEnd(8)} ${s.cwd}${s.discovered ? '  [discovered]' : ''}`)
  process.exit(0)
}

if (flag('--retarget')) {
  const id = val('--retarget')
  const to = val('--to')
  if (!id || !to) { console.error('rewalk comment --retarget <id> --to <session_id>'); process.exit(2) }
  const r = await hubCall('retarget', { id, target: to })
  if (!r?.ok) { console.error(`rewalk comment: ${r?.error ?? 'no hub running'}`); process.exit(2) }
  console.log(`${r.id} ${r.status} -> ${r.to}`)
  process.exit(0)
}

if (flag('--untarget')) {
  const id = val('--untarget')
  if (!id) { console.error('rewalk comment --untarget <id>'); process.exit(2) }
  const r = await hubCall('untarget', { id })
  if (!r?.ok) { console.error(`rewalk comment: ${r?.error ?? 'no hub running'}`); process.exit(2) }
  console.log(`${r.id} ${r.status} — target cleared; it now goes to whichever session is working in its directory`)
  process.exit(0)
}

if (flag('--list')) {
  const r = await hubCall('status', {})
  if (!r) { console.log('no hub running'); process.exit(1) }
  const comments = /** @type {any[]} */ (r.comments ?? [])
  if (!comments.length) { console.log('no comments queued'); process.exit(0) }
  const sessions = /** @type {any[]} */ (r.sessions ?? [])
  for (const c of comments) {
    // Why a queued comment is still queued is the question this answers. A
    // session that has never fired a hook cannot claim anything — the usual
    // cause being that it was started before the hooks were installed, since
    // the harness reads them once at startup.
    const notes = []
    if (c.status === 'queued' && c.target) {
      const s = sessions.find((x) => x.session_id === c.target || `pid:${x.pid}` === c.target)
      notes.push(!s ? 'target is not running'
        : s.discovered || !s.event ? 'target has never fired a hook (started before they were installed? restart it, or --untarget)'
        : 'waiting for its next tool call')
    }
    if (c.woke) notes.push(`nudged ${c.woke.slug} via ${c.woke.how}`)
    console.log(`${c.id.padEnd(8)} ${String(c.status).padEnd(10)} ${c.target ?? '(routed by cwd)'}  ${JSON.stringify(String(c.text).slice(0, 50))}` +
      (notes.length ? `  <- ${notes.join('; ')}` : ''))
  }
  process.exit(0)
}

/** @type {unknown} */
let raw
const file = val('--file')
if (file) {
  const text = file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8')
  try { raw = JSON.parse(text) } catch (e) {
    console.error(`rewalk comment: ${file} is not valid JSON`)
    process.exit(2)
  }
} else {
  const text = val('--text')
  if (!text) { console.error('rewalk comment: --text or --file is required\n'); console.error(USAGE); process.exit(2) }
  let dir = val('--session') ?? null
  // Fail here rather than queueing a path the agent cannot open.
  if (dir) { try { dir = resolveSessionDir(dir) } catch (e) {
    console.error(`rewalk comment: ${e instanceof Error ? e.message : String(e)}`); process.exit(2) } }
  raw = {
    kind: KIND,
    text,
    nodes: all('--node').map((s) => ({ s })),
    page: { ...(val('--url') ? { url: val('--url') } : {}) },
    session: dir ? { dir, ...(flag('--recording') ? { recording: true } : {}) } : null,
    target: val('--to') ?? null,
    where: { cwd: val('--cwd') ?? process.cwd() },
    createdWall: Date.now(),
  }
}

const v = normalizeComment(raw)
if (!v.ok) { console.error(`rewalk comment: ${v.reason}`); process.exit(2) }

if (flag('--render')) {
  console.log(renderComment({ ...v.comment, id: v.comment.id ?? 'rwc-preview' }))
  process.exit(0)
}

await ensureHub()
const res = await hubCall('comment', { comment: v.comment })
if (!res) {
  console.error('rewalk comment: no hub is running and one could not be started.\n  try: node bin/hub.mjs serve')
  process.exit(3)
}
if (!res.ok) { console.error(`rewalk comment: hub refused it — ${res.error}`); process.exit(2) }

// Say what actually happens next. Delivery is a pull: the comment waits until
// the target session's next hook fires, and an idle session fires none.
const status = String(res.status)
console.log(`${res.id}  ${status}`)
console.log(status === 'held'
  ? '  held until that recording finishes (rewalk release runs at the end of finishing)'
  : '  waiting for the target session\'s next tool call or turn end; an idle session receives nothing until it works again')
