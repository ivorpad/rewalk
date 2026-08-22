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

  rewalk watch <url> [outDir]   record a session: rrweb + voice + pointing
  rewalk read <sessionDir>      utterances resolved to DOM deltas
  rewalk run [--csv cases.csv]  walk a CSV of steps, emit replay + traces + report
  rewalk check <checks.mjs>     run named feature checks over CDP, exit non-zero on failure
  rewalk map [routes...]        write out/dom-map.md — every form, button and input
  rewalk replay                 pack the last run into out/replay.html
  rewalk mic                    confirm the microphone is heard before recording

First run, once:
  cd ${SKILL.replace(process.env.HOME ?? "", "~")} && npm install

Testing a site you did not write:
  rewalk map https://example.com     # see what is actually there
  cp skill/assets/qa.config.example.json qa.config.json && $EDITOR qa.config.json
  rewalk run                          # cases.csv -> out/replay.html
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
const needsEngine = ["run", "check", "map", "replay", "watch"];
if (needsEngine.includes(verb) && !existsSync(join(SKILL, "node_modules/playwright"))) {
  console.error(`rewalk: dependencies are not installed.\n  cd ${SKILL} && npm install\n`);
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
  case "check":
    if (!rest[0]) { console.error("rewalk check <checks.mjs>   (a module importing skill/scripts/cdp-harness.mjs)"); process.exit(2); }
    run(resolve(process.cwd(), rest[0]), rest.slice(1));
    break;
  case "map":
    run(join(SKILL, "scripts/introspect.mjs"), rest);
    break;
  case "replay":
    run(join(SKILL, "scripts/build-viewer.mjs"), rest);
    break;
  case "mic":
    run(join(ROOT, "bin/mic-check.mjs"), rest);
    break;
  default:
    console.error(`rewalk: unknown verb "${verb}"\n\n${USAGE}`);
    process.exit(2);
}
