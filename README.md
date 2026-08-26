# rewalk

Record a person using any web page — rrweb DOM stream, their voice, alt-click
pointing, per-request network/console, and on React apps the component every
click landed on — then resolve each spoken complaint to the DOM deltas it was
about. Artifacts a coding agent can act on: `resolved.json`, `located.json`,
`replay.html`, `replay.mp4`, `walkthrough.md`.

This repository is the product (`rewalk/`) plus the Claude Code skill
(`rewalk-skill/`). The long research log lives in [`rewalk/README.md`](rewalk/README.md)
and [`rewalk/FINDINGS.md`](rewalk/FINDINGS.md).

## Install (one command after clone)

rewalk is plain ESM. There is no JS build. The two macOS apps **cannot** ship
as prebuilt binaries: TCC binds the microphone grant to the signing identity
on *this* machine. A foreign signature is a different app to TCC than one
signed here. So distribution is `git clone` + `install.sh`, not npm and not a
Homebrew bottle.

```
git clone https://github.com/ivorpad/rewalk.git
cd rewalk
sh install.sh
```

What `install.sh` does:

1. `npm install` in `rewalk/` (the skill's Playwright/rrweb engine is a
   postinstall).
2. Regenerates `chrome-ext/src/boot.main.js` from `lib/` (that file is
   generated and not committed).
3. On macOS: creates a per-machine `rewalk signing` identity if needed
   (`lib/mac/make-signing-identity.sh` — one keychain trust dialog), then
   `swiftc` + `codesign` for `rewalk-mic.app` and `rewalk-voiced.app`.
4. Writes a `rewalk` shim to `~/.local/bin/rewalk` (node path baked in).
5. Symlinks `rewalk-skill/` → `~/.claude/skills/rewalk`.
6. Writes `~/.config/rewalk/config.json` if missing (does not overwrite).
7. Prompts for a Deepgram key or skips. The key is `~/.config/rewalk/deepgram.key`
   at mode `0600`, read at the moment of use, never put in the environment.
   No key = DOM-only sessions; replay still works.

What it **prints** and never runs (human-consent steps):

```
sh rewalk/chrome-ext/host/install.sh
# chrome://extensions → Developer mode → Load unpacked → rewalk/chrome-ext

sh rewalk/daemon/install.sh          # optional; toolbar-button-only recording
```

First capture, macOS prompts twice (once per bundle id):

- `com.rewalk.mic` — the capturer
- `com.rewalk.voiced` — the menu bar / LaunchAgent wrapper

Grant both. A denial is peak `0.000000`, not a crash. Check with:

```
rewalk mic 6
```

`--prefix DIR` relocates the shim, skill symlink, and config for a dry run.
`--skip-deepgram` skips the key prompt. `--skip-apps` skips the Swift build
(JS + skill only).

## After install

```
rewalk doctor                        # verify the whole chain; failures name their fix
rewalk session                       # real Chrome; click the toolbar button
rewalk watch <url> [outDir]          # fresh Playwright Chromium
rewalk read <session>
rewalk replay <session>
rewalk share <session>               # video + replay.html + agent metadata
rewalk locate <session> <repo>
```

After every `git pull`: `sh install.sh` again (deps, boot.main.js, re-sign —
the mic grant survives), then **reload the extension** at `chrome://extensions`.
Chrome runs the old extension code until that reload; a stale service worker
is how one machine kept recording after stop. `rewalk doctor` verifies both.

Session directories default to `rewalk/out/`. Finished copies default to
`~/Downloads`, names like `rewalk-2026-08-26T09-30-ext-1787668028307.mp4`.
Override in `~/.config/rewalk/config.json`:

```json
{
  "sessionsDir": "/absolute/or/~/path",
  "artifacts": {
    "dest": "~/Downloads",
    "copy": ["video"],
    "exportVideo": true
  }
}
```

`copy` may include `video`, `replay`, and `bundle` (`resolved.json` +
`located.json` + `session.json`). Defaults match the previous hardcoding:
export the mp4 and copy only that file to Downloads.

Without a Deepgram key, voice still writes a wav when the signed bundle can
hear you; live utterance streaming is skipped. `read` can transcribe later
with local whisper if `whisper-cli` is installed.

## Fresh-machine dry run (what was actually executed)

A stranger-machine install was **not** run. Two honest approximations exist.

Fresh-CLONE run, 2026-08-26, same machine: `git clone` into a temp dir,
`sh install.sh --prefix <tmp> --skip-deepgram` from the clone. Everything a
clone needs proved to be tracked: npm install, boot.main.js regenerated, both
apps built and signed (identity already existed here), shim + skill + config
written, `rewalk doctor` exit 0 from the clone's shim, and `bin/lab-run.mjs`
scored 5/5 from the clone. What that run cannot exercise is exactly the
first-time-Mac list at the end of this section.

Earlier the same day, the prefix dry run from the working checkout:

```
sh install.sh --prefix /tmp/rewalk-dry --skip-deepgram
```

Verified after that command:

- `/tmp/rewalk-dry/bin/rewalk` — shim, node path baked, `--help` works
- `/tmp/rewalk-dry/skills/rewalk` → this repo’s `rewalk-skill/`
- `/tmp/rewalk-dry/config/rewalk/config.json` written (sessionsDir =
  `<checkout>/rewalk/out`, dest `~/Downloads`, copy `["video"]`)
- Deepgram prompt skipped; no key written under the prefix
- `codesign -dv` on both apps: `Authority=rewalk signing`,
  ids `com.rewalk.mic` and `com.rewalk.voiced`
- Human Chrome/daemon steps printed; `host/install.sh` and
  `daemon/install.sh` were **not** executed
- `chrome-ext/src/boot.main.js` regenerated (287KB)

Share / routing (same sitting, after the config work):

```
REWALK_CONFIG=/tmp/rewalk-share-cfg.json node bin/share.mjs out/session7
```

wrote `/tmp/rewalk-share-dest/rewalk-2026-08-22T10-30-session7/` containing
the mp4, replay.html, resolved.json, session.json (no located.json on that
session). session7 files were sha256-identical before and after. A fake
session with `copy: ["video","replay","bundle"]` produced timestamped
names `rewalk-<stamp>-<id>.{mp4,html}` plus a `-meta/` folder. Video
export was not re-run (`exportVideo: false`; session7 already had
`replay.mp4`).

What a first-time Mac still has to do by hand, and that this sitting did
**not** re-do:

- the keychain trust dialog for a *new* `rewalk signing` identity
- the two TCC microphone prompts (`com.rewalk.mic`, `com.rewalk.voiced`)
- Chrome “Load unpacked”
- `chrome-ext/host/install.sh` and `daemon/install.sh` (printed, not run)
- a toolbar-button recording on a machine that has never granted the mic

Baselines after the three milestones (from `rewalk/`, 2026-08-26):

- `node bin/lab-run.mjs` — 5/5
- `node bin/check.mjs` — 4/5 (motion-settles UNFALSIFIABLE — never seen red)
- `REWALK_STT=deepgram node bin/score.mjs out/session7` — 4/4
- `npm run typecheck` — exit 0

## Why not npm or Homebrew

- **npm:** JS is already zero-build, but `npm install -g` would invite
  shipping the `.app` bundles from CI. Those bundles must be signed on the
  user’s machine. A postinstall that shells out to `swiftc` + `security
  add-trusted-cert` is the same work as `install.sh`, with a worse place to
  put `chrome-ext/` for “Load unpacked”.
- **Homebrew tap:** same bottle problem. A formula that just clones and
  runs `install.sh` is an extra hop, not a simpler install.

CI runs `npm run typecheck` (`tsc --checkJs`) on the session contracts
(`lib/deltas.mjs`, `lib/resolve.mjs`, `lib/utterances.mjs`, `lib/finish.mjs`,
config/artifacts). JS stays uncompiled ESM.

## Requirements

- Node >= 18
- macOS + Xcode Command Line Tools (`swiftc`) for voice
- Chrome, for the real-profile route
- `ffmpeg` only for `rewalk video` / finish-time mp4 export — not for capture
- Optional: Deepgram key; `whisper-cli` for offline transcription
- Optional: `~/.local/bin` on `PATH`
