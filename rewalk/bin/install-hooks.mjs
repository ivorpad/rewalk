#!/usr/bin/env node
// Put the four lifecycle hooks where the harness will find them.
//
// Claude Code reads ~/.claude/settings.json; Codex reads ~/.codex/hooks.json
// and wants `hooks = true` in config.toml. Both take the same event names and
// the same {type, command, timeout} shape, so one installer covers both.
//
// THE TRAP, and why the match below is exact rather than a prefix: sibling
// tools of this design (tap, attention-canvas) install their own hooks the
// same way, and each removes its prior entries before adding fresh ones so an
// upgrade does not leave two firing. The upstream did that with
// `command.startswith(bin)`. Ours is a THIRD such tool on machines that have
// the others, and a loose match is how one tool silently deletes another's
// hooks. We remove only commands whose first word is exactly our own binary.
//
//   node bin/install-hooks.mjs [--uninstall] [--bin /path/to/rewalk-hook]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HOME = os.homedir()
const CLAUDE_SETTINGS = path.join(HOME, '.claude', 'settings.json')
const CODEX_HOOKS = path.join(HOME, '.codex', 'hooks.json')
const CODEX_CONFIG = path.join(HOME, '.codex', 'config.toml')

/** @type {[string, string | null, string, number][]} */
const ENTRIES = [
  ['SessionStart', null, 'register', 10],
  ['PostToolUse', '*', 'drain', 10],
  ['Stop', null, 'drain --stop', 10],
  // Claude-only; Codex never fires it, which is what the session TTL covers.
  ['SessionEnd', null, 'register --gone', 5],
]

const argv = process.argv.slice(2)
const remove = argv.includes('--uninstall')
const binAt = argv.indexOf('--bin')
// Prefer the installed shim (stable across a `git pull`), fall back to the
// checkout's own script with node baked in the same way the CLI shim does.
const HOOK_BIN = binAt >= 0 && argv[binAt + 1]
  ? argv[binAt + 1]
  : fs.existsSync(path.join(HOME, '.local/bin/rewalk-hook'))
    ? path.join(HOME, '.local/bin/rewalk-hook')
    : `${process.execPath} ${path.join(ROOT, 'bin/hook.mjs')}`

/** @param {string} p */
function load(p) {
  if (!fs.existsSync(p)) return {}
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) || {} }
  catch (e) {
    console.error(`rewalk: ${p} is not readable json; fix or move it first`)
    process.exit(1)
  }
}

/** @param {string} p @param {any} data */
function save(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  if (fs.existsSync(p)) fs.copyFileSync(p, `${p}.bak-rewalk`)
  const tmp = `${p}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n')
  fs.renameSync(tmp, p)
}

/** Is this hook entry one of ours? Exact command, never a prefix of somebody's.
 * @param {string} command */
function isOurs(command) {
  const c = String(command ?? '').trim()
  for (const [, , suffix] of ENTRIES) if (c === `${HOOK_BIN} ${suffix}`) return true
  // An older install of ours under a different path still has to be removable,
  // or an upgrade leaves the stale one firing. Match our script name, which no
  // sibling tool shares.
  return /(^|[/ ])rewalk-hook( |$)/.test(c) || /bin\/hook\.mjs( |$)/.test(c)
}

/** @param {any} settings @returns {number} */
function apply(settings) {
  const hooks = settings.hooks ?? (settings.hooks = {})
  let changed = 0
  for (const [event, matcher, suffix, timeout] of ENTRIES) {
    const groups = hooks[event] ?? (hooks[event] = [])
    for (const group of [...groups]) {
      const inner = group.hooks ?? []
      const keep = inner.filter((/** @type {any} */ h) => !isOurs(h?.command))
      if (keep.length !== inner.length) { group.hooks = keep; changed++ }
      if (!group.hooks?.length) groups.splice(groups.indexOf(group), 1)
    }
    if (remove) { if (!groups.length) delete hooks[event]; continue }
    /** @type {any} */
    const entry = { hooks: [{ type: 'command', command: `${HOOK_BIN} ${suffix}`, timeout }] }
    if (matcher) entry.matcher = matcher
    groups.push(entry)
    changed++
    hooks[event] = groups
  }
  if (remove && !Object.keys(hooks).length) delete settings.hooks
  return changed
}

const done = []
const claude = load(CLAUDE_SETTINGS)
if (apply(claude)) { save(CLAUDE_SETTINGS, claude); done.push(`${remove ? 'removed from' : 'installed into'} ${CLAUDE_SETTINGS}`) }

if (fs.existsSync(CODEX_HOOKS) || fs.existsSync(CODEX_CONFIG)) {
  const codex = load(CODEX_HOOKS)
  if (apply(codex)) { save(CODEX_HOOKS, codex); done.push(`${remove ? 'removed from' : 'installed into'} ${CODEX_HOOKS}`) }
  if (!remove && fs.existsSync(CODEX_CONFIG) && !fs.readFileSync(CODEX_CONFIG, 'utf8').includes('hooks = true'))
    done.push(`NOTE: add \`hooks = true\` to ${CODEX_CONFIG} or Codex ignores hooks.json`)
}

console.log(`hook command: ${HOOK_BIN}`)
for (const line of done.length ? done : ['nothing to do']) console.log(`  ${line}`)
