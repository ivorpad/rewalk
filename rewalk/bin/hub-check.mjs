// What the hub calls a session, asserted.
//
// Three independent human names arrive for one session and they do not agree,
// so sessionLabel picks between them once and every surface renders the result.
// Nothing tested that choice. bin/ext-check.mjs feeds its fake hub sessions
// whose `label` is already decided and only asserts the picker renders it
// rather than re-deciding, so the ladder itself — the default-pane regex, the
// order of the rungs — was exercised nowhere. Swapping two lines in
// sessionLabel broke nothing.
//
// The registration shape underneath it is here for the same reason. The
// renamed title used to land in `slug`, which is also the cwd-basename
// fallback, so nothing downstream could tell "somebody called this session
// payments" from "this session happens to live in ~/src/payments". Splitting
// them is only half the fix: busy events do not pay for the transcript read and
// arrive with no title at all, so touch() has to keep the prior one or a single
// tool call blanks the name a person chose.
//
//   node bin/hub-check.mjs

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sessionLabel, SessionRegistry } from '../lib/hub-state.mjs'

const fail = []
let ran = 0
/** @param {string} name @param {any} cond @param {any} [detail] */
const ok = (name, cond, detail) => {
  ran++
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name.padEnd(58)} ${detail ?? ''}`)
  if (!cond) fail.push(name)
}

// --- the ladder --------------------------------------------------------------
// A pane nobody has named carries the agent's own name, which tells nobody
// anything: three claudes in one repo are three rows reading "claude". So a
// real pane name wins, a default one steps aside for the rename, and the
// directory is the floor.
console.log('--- the naming ladder ---')

/** @type {[string, any, string][]} */
const LADDER = [
  ['a real pane name beats an explicit rename',
    { pane_name: 'checkout', title: 'rewrite the ledger', slug: 'shop', cwd: '/x/shop' }, 'checkout'],
  ['a default pane name steps aside for the rename',
    { pane_name: 'claude', title: 'rewrite the ledger', slug: 'ledger', cwd: '/x/ledger' }, 'rewrite the ledger'],
  ['a numbered default pane name steps aside too',
    { pane_name: 'claude 2', title: 'rewrite the ledger', slug: 'ledger', cwd: '/x/ledger' }, 'rewrite the ledger'],
  ['and a punctuated one — herdr writes several shapes',
    { pane_name: 'codex-3', title: 'rewrite the ledger', slug: 'ledger', cwd: '/x/ledger' }, 'rewrite the ledger'],
  ['case does not make a default pane name real',
    { pane_name: 'Claude', title: 'rewrite the ledger', slug: 'ledger', cwd: '/x/ledger' }, 'rewrite the ledger'],
  ['a pane name that merely starts with the agent IS real',
    { pane_name: 'claude code review', title: 'rewrite the ledger', slug: 'ledger', cwd: '/x/ledger' },
    'claude code review'],
  ['with no rename, the directory is the floor',
    { pane_name: 'claude', title: '', slug: 'ledger', cwd: '/x/ledger' }, 'ledger'],
  ['with no pane at all, the rename still wins',
    { title: 'rewrite the ledger', slug: 'ledger', cwd: '/x/ledger' }, 'rewrite the ledger'],
  ['whitespace is not a name',
    { pane_name: '   ', title: '  ', slug: 'ledger', cwd: '/x/ledger' }, 'ledger'],
  ['a default pane is better than nothing when nothing else is set',
    { pane_name: 'claude', title: '', slug: '', cwd: '/x/ledger' }, 'claude'],
  ['and the cwd is the last thing left',
    { title: '', slug: '', cwd: '/x/ledger' }, '/x/ledger'],
  ['a session with nothing at all does not throw', {}, ''],
]
for (const [name, session, want] of LADDER) {
  const got = sessionLabel(session)
  ok(name, got === want, `${JSON.stringify(got)}${got === want ? '' : ` (wanted ${JSON.stringify(want)})`}`)
}
ok('null does not throw', sessionLabel(null) === '', JSON.stringify(sessionLabel(null)))

// --- the shape it reads ------------------------------------------------------
console.log('\n--- registration keeps a rename alive ---')

const mirror = fs.mkdtempSync(path.join(os.tmpdir(), 'rewalk-hub-check-'))
try {
  const reg = new SessionRegistry(mirror)

  // SessionStart pays for the transcript read and knows both names.
  const start = reg.touch({
    session_id: 's1', agent: 'claude', cwd: '/Users/x/src/payments',
    slug: 'payments', title: 'refund flow', pid: 4242,
  })
  ok('the rename lands in title', start?.title === 'refund flow', start?.title)
  ok('and the directory stays in slug', start?.slug === 'payments', start?.slug)

  // A busy event: no transcript read, so no title, and it must not blank one.
  const busy = reg.touch({ session_id: 's1', agent: 'claude', cwd: '/Users/x/src/payments', event: 'PostToolUse' })
  ok('a busy event does not blank the rename', busy?.title === 'refund flow', busy?.title)
  ok('the label survives the busy event', sessionLabel(busy) === 'refund flow', sessionLabel(busy))

  // A rename mid-session is a new title, not a merge with the old one.
  const renamed = reg.touch({
    session_id: 's1', agent: 'claude', cwd: '/Users/x/src/payments', slug: 'payments', title: 'chargebacks',
  })
  ok('a later rename replaces the earlier one', renamed?.title === 'chargebacks', renamed?.title)

  // Without a slug, touch falls back to the cwd basename — never to the title.
  const bare = reg.touch({ session_id: 's2', agent: 'codex', cwd: '/Users/x/src/shop', title: 'checkout bug' })
  ok('slug falls back to the cwd basename, not the title', bare?.slug === 'shop', bare?.slug)
  ok('and such a session labels as its rename', sessionLabel(bare) === 'checkout bug', sessionLabel(bare))

  // The mirror on disk is what a restarted hub reads back.
  const onDisk = JSON.parse(fs.readFileSync(path.join(mirror, 's1.json'), 'utf8'))
  ok('the mirror carries title and slug apart', onDisk.title === 'chargebacks' && onDisk.slug === 'payments',
    `title=${onDisk.title} slug=${onDisk.slug}`)
} finally {
  fs.rmSync(mirror, { recursive: true, force: true })
}

console.log(`\n${fail.length ? `FAILED: ${fail.join(', ')}` : `all ${ran}/${ran} hub checks passed`}`)
process.exit(fail.length ? 1 : 0)
