// Probe (A2, throwaway): bin/locate.mjs + component tokens. A2's ablation
// PASSED its target criterion (accounts complaint at rank 2 via the
// AccountsPage mark) but KILLED on stability: the AppLayout token from a
// layout-furniture delta (the sidebar, rank-1 by page-growth noise) outranked
// the skeleton complaint's true referent. Kept as a probe so the ablation is
// reproducible; bin/locate.mjs stays pristine per the evidence-first rule.
//   node probes/locate-components.mjs <sessionDir> <repoDir>
// rewalk locate — from a resolved complaint to the file that renders it.
//
// The gap this closes, measured on the first real-app session: the join can
// say `[aria-label="New tag"] rect.y 704 -> 729`, and an agent holding that
// string still has to find the component before it can fix anything. React 19
// dropped _debugSource, and on a Server Components app the client fibers only
// contain router internals (probed on ledger: every element walks up to
// LayoutRouterContext and stops). So source location cannot be read from the
// page. It CAN be read from the repo: the selector's distinctive tokens --
// aria-labels, testids, hand-written ids, class combinations -- were typed by
// someone, in a file.
//
// This is deliberately probabilistic and says so: every hit carries the token
// that found it, and a miss is reported as a miss rather than as the
// nearest-scoring wrong file.
//
//   node bin/locate.mjs <sessionDir> <repoDir>

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const DIR = process.argv[2]
const REPO = process.argv[3]
if (!DIR || !REPO) { console.error('usage: node bin/locate.mjs <sessionDir> <repoDir>'); process.exit(2) }
const resolved = JSON.parse(fs.readFileSync(path.join(DIR, 'resolved.json'), 'utf8'))

// What in a selector is worth grepping for, strongest first. A quoted
// aria-label was written by a person and is nearly unique; a Tailwind utility
// class appears four hundred times and is worth nothing.
function tokens(selector) {
  const out = []
  for (const m of selector.matchAll(/\[aria-label="([^"]+)"\]/g)) out.push({ t: m[1], kind: 'aria-label', w: 4 })
  for (const m of selector.matchAll(/\[data-testid="([^"]+)"\]/g)) out.push({ t: m[1], kind: 'data-testid', w: 4 })
  for (const m of selector.matchAll(/#([A-Za-z][-\w]*)/g))
    if (!/^(__next|node)/.test(m[1])) out.push({ t: m[1], kind: 'id', w: 3 })
  // classes: only ones that look authored, not generated utilities
  for (const m of selector.matchAll(/\.([a-z][-\w]*)/g)) {
    const c = m[1]
    if (/^(w|h|p|m|px|py|mx|my|mt|mb|ml|mr|pt|pb|pl|pr|gap|text|bg|border|rounded|flex|grid|items|justify|min|max|inset|fixed|absolute|relative|hidden|block|animate|space|divide|font|leading|tracking|shadow|ring|outline|transition|duration|hover|focus|last|first|md|lg|sm|xl)$/.test(c)) continue
    if (/^(w|h|p|m|px|py|mx|my|mt|mb|ml|mr|pt|pb|pl|pr|gap|text|bg|border|rounded|min|max|space|divide|duration)-/.test(c)) continue
    if (c.length < 4) continue
    out.push({ t: c, kind: 'class', w: 1 })
  }
  return out
}

function grepRepo(token) {
  const r = spawnSync('grep', ['-rn', '--include=*.tsx', '--include=*.jsx', '--include=*.ts',
    '--include=*.js', '--include=*.html', '--include=*.vue', '--include=*.svelte',
    '--exclude-dir=node_modules', '--exclude-dir=.next', '--exclude-dir=dist', '--exclude-dir=out',
    '-F', token, REPO], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  if (r.status !== 0) return []
  return r.stdout.trim().split('\n').filter(Boolean).map((l) => {
    const m = /^(.+?):(\d+):/.exec(l)
    return m ? { file: path.relative(REPO, m[1]), line: +m[2] } : null
  }).filter(Boolean)
}

const out = []
for (const u of resolved) {
  const list = (u.query === 'stasis' ? (u.held?.length ? u.held : u.deltas) : u.deltas) ?? []
  const files = new Map()   // file -> {score, hits:[{token,kind,line}]}
  // component tokens: one vote per distinct name per utterance, id-strength.
  const componentTokens = new Set()
  for (const d of list.slice(0, 3)) if (d.component) componentTokens.add(d.component)
  for (const i of u.interactions ?? []) if (i.component) componentTokens.add(i.component)
  const utterTokens = [...componentTokens].map((t) => ({ t, kind: 'component', w: 3 }))
  for (const d of list.slice(0, 3)) utterTokens.push(...tokens(d.node))
  {
    for (const tok of utterTokens) {
      const hits = grepRepo(tok.t)
      if (!hits.length || hits.length > 40) continue   // absent, or too common to mean anything
      const perHit = tok.w / hits.length               // a token in one file is worth more
      for (const h of hits) {
        const f = files.get(h.file) ?? { score: 0, hits: [] }
        // A test or verify script quoting the same aria-label is evidence, but
        // the person fixing the bug wants the component that RENDERS it.
        // Measured before this: scripts/verify-quality/drawer.ts tied with the
        // actual drawer component on every drawer complaint.
        const testish = /\b(test|spec|verify|e2e|fixture|__tests__|\.stories\.)/i.test(h.file)
        f.score += testish ? perHit * 0.4 : perHit
        if (f.hits.length < 4) f.hits.push({ token: tok.t, kind: tok.kind, line: h.line })
        files.set(h.file, f)
      }
    }
  }
  const ranked = [...files.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, 3)
    .map(([file, v]) => ({ file, score: +v.score.toFixed(2), via: v.hits }))
  const said = u.said ?? u.text ?? ''
  out.push({ text: said, query: u.query, top: list[0] ? `${list[0].node} ${list[0].prop}` : null, sources: ranked })
  console.log(`"${said.slice(0, 70)}${said.length > 70 ? '…' : ''}"`)
  if (!ranked.length) { console.log('   no source located (no distinctive token survived)\n'); continue }
  for (const r of ranked)
    console.log(`   ${String(r.score).padStart(6)}  ${r.file}  (${r.via.map((h) => `${h.kind}:"${h.token}"@${h.line}`).join(', ')})`)
  console.log()
}
fs.writeFileSync(path.join(DIR, 'located.json'), JSON.stringify(out, null, 1))
console.log(`-> ${path.join(DIR, 'located.json')}`)
