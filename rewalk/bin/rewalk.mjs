#!/usr/bin/env node
// rewalk — one entry point for the verbs.
//
// Two ways to check a site, and they answer different questions:
//
//   watch/read   a person uses the site and says what is wrong; the recording
//                resolves each utterance to the DOM change it was about
//   run/check    the same ground walked scripted, so a finding becomes a gate
//
// Nothing here is specific to any site. `run` and `check` are the web-qa engine
// in skill/, which is also installed as the /web-qa skill.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const SKILL = join(ROOT, "skill");

const [verb, ...rest] = process.argv.slice(2);

const USAGE = `rewalk — record a person using a site, resolve what they said to what the DOM did,
then re-walk the same ground scripted.

  rewalk session [outDir]       one command: voice companion + extension DOM, merged and read
  rewalk watch <url> [outDir]   record a session (CLI browser): rrweb + voice + pointing
  rewalk read <sessionDir>      utterances resolved to DOM deltas
  rewalk run [--csv cases.csv]  walk a CSV of steps, emit traces + report + results
  rewalk check <checks.mjs>     run named feature checks over CDP, exit non-zero on failure
  rewalk map [routes...]        write out/dom-map.md — every form, button and input
  rewalk replay [sessionDir]    pack a recording into a playable replay.html
  rewalk locate <session> <repo>  map resolved complaints to the source files that render them
  rewalk stream-audio [outDir]  voice companion (live to Deepgram): wall-stamped utterances as you speak
  rewalk sync <dom> <audio>     join a DOM recording and a voice recording by wall clock
  rewalk video [sessionDir]     export replay.html as replay.mp4 (ffmpeg; not capture)
  rewalk share [sessionDir]     video + replay.html + agent metadata → configured dest
  rewalk mic                    confirm the microphone is heard before recording
  rewalk comment                send a comment (+ the nodes it is about) to an agent session
  rewalk hub [serve|status|stop]  the queue between the browser and agent sessions
  rewalk doctor                 verify the install chain; every failure names its fix

Install (once, from the repo root — not this file):
  sh install.sh                 local sign of the mic apps; prints Chrome/daemon steps

First run, once:
  cd ${SKILL.replace(process.env.HOME ?? "", "~")} && pnpm install

Testing a site you did not write:
  cp skill/assets/qa.config.example.json qa.config.json && $EDITOR qa.config.json
  rewalk map                          # see what is actually there
  rewalk run                          # cases.csv -> out/report.md, out/results.csv
  rewalk replay                       # -> out/replay.html

A checks file is told where the harness is, so it need not know where this
repo lives:

  const { check, evl, nav, report } = await import(process.env.REWALK_HARNESS)
`;

if (!verb || verb === "-h" || verb === "--help") {
  console.log(USAGE);
  process.exit(verb ? 0 : 1);
}

const run = (script, args, env = {}) => {
  if (!existsSync(script)) {
    console.error(`rewalk: ${script} is missing — has the repo been moved?`);
    process.exit(3);
  }
  const child = spawn(process.execPath, [script, ...args], {
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
};

// Dependencies live in skill/, because that directory ships as the /web-qa
// skill and has to carry what it needs. Fail with the fix rather than a stack.
// `check` is absent on purpose: the CDP harness talks to the browser the user
// already has over a debugging port, and needs no Playwright and no Chromium
// download. Gating it here refused a verb that would have worked.
const needsEngine = ["run", "map", "replay", "watch"];
if (needsEngine.includes(verb) && !existsSync(join(SKILL, "node_modules/playwright"))) {
  console.error(`rewalk: dependencies are not installed.\n  cd ${SKILL} && pnpm install\n`);
  process.exit(3);
}

switch (verb) {
  case "watch":
    if (!rest[0]) { console.error("rewalk watch <url> [outDir]"); process.exit(2); }
    run(join(ROOT, "probes/record-session.mjs"), rest);
    break;
  case "read":
    if (!rest[0]) { console.error("rewalk read <sessionDir>"); process.exit(2); }
    run(join(ROOT, "bin/read.mjs"), rest);
    break;
  case "run": {
    const i = rest.indexOf("--csv");
    const csv = i >= 0 ? rest[i + 1] : process.env.CSV;
    run(join(SKILL, "scripts/qa.mjs"), [], csv ? { CSV: csv } : {});
    break;
  }
  case "check": {
    if (!rest[0]) { console.error("rewalk check <checks.mjs>   (a module importing skill/scripts/cdp-harness.mjs)"); process.exit(2); }
    // The checks file lives in the user's project, not here, so it cannot know
    // the path to the harness. Hand it over rather than making them hardcode it.
    const harness = join(SKILL, "scripts/cdp-harness.mjs");
    if (!existsSync(harness)) { console.error(`rewalk: ${harness} is missing — has the repo been moved?`); process.exit(3); }
    run(resolve(process.cwd(), rest[0]), rest.slice(1), { REWALK_HARNESS: harness, REWALK_SKILL: SKILL });
    break;
  }
  case "map":
    run(join(SKILL, "scripts/introspect.mjs"), rest);
    break;
  case "replay":
    // Two different recordings, two different viewers. A session directory came
    // from `watch` and is one continuous human recording; anything else is the
    // scripted runner's out/ with run.json and per-flow streams.
    if (rest[0] && existsSync(join(resolve(process.cwd(), rest[0]), "events.ndjson")))
      run(join(ROOT, "bin/replay.mjs"), rest);
    else run(join(SKILL, "scripts/build-viewer.mjs"), rest);
    break;
  case "locate":
    if (!rest[0] || !rest[1]) { console.error("rewalk locate <sessionDir> <repoDir>"); process.exit(2); }
    run(join(ROOT, "bin/locate.mjs"), rest);
    break;
  case "session":
    run(join(ROOT, "bin/session.mjs"), rest);
    break;
  case "stream-audio":
    run(join(ROOT, "bin/stream-audio.mjs"), rest);
    break;
  case "sync":
    if (!rest[0] || !rest[1]) { console.error("rewalk sync <domDir> <audioDir> [outDir]"); process.exit(2); }
    run(join(ROOT, "bin/sync.mjs"), rest);
    break;
  case "video":
    if (!rest[0]) { console.error("rewalk video <sessionDir>"); process.exit(2); }
    run(join(ROOT, "bin/video.mjs"), rest);
    break;
  case "share":
    if (!rest[0]) { console.error("rewalk share <sessionDir> [--zip]"); process.exit(2); }
    run(join(ROOT, "bin/share.mjs"), rest);
    break;
  case "mic":
    run(join(ROOT, "bin/mic-check.mjs"), rest);
    break;
  case "comment":
    run(join(ROOT, "bin/comment.mjs"), rest);
    break;
  case "hub":
    run(join(ROOT, "bin/hub.mjs"), rest);
    break;
  case "doctor":
    run(join(ROOT, "bin/doctor.mjs"), rest);
    break;
  default:
    console.error(`rewalk: unknown verb "${verb}"\n\n${USAGE}`);
    process.exit(2);
}
