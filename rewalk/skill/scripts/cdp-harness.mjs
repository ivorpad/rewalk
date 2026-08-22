// A CDP driver for checking a running web app, feature by feature.
//
// Complements qa.mjs rather than duplicating it. qa.mjs walks a CSV of steps
// and is the right shape when the cases are a list of interactions. This is the
// right shape when what you have is a *map of features* — an id per behaviour,
// a named check per id, and a run that reports pass or fail for each. The ids
// are yours; nothing here knows or cares what they mean.
//
// Nothing in this module is specific to any app. Helpers that encode one app's
// vocabulary — its landmarks, its status readouts — belong in that app's own
// module, built on `evl` and the selector builders here.
//
// This module is a singleton, so `results` and `consoleErrors` are the same
// objects in every importer. That is what lets a final check assert that
// nothing anywhere in the session logged an error.
//
//   Connect:  headless Chrome with --remote-debugging-port, CDP_PORT to match.
//   Emit:     one "<id> PASS|FAIL <detail>" line per check, then RESULTS_JSON.
//   Exit:     0 when every check passed, 1 when any failed.

const PORT = process.env.CDP_PORT ?? "9337";
const VIEWPORT = {
  width: Number(process.env.VW ?? 1440),
  height: Number(process.env.VH ?? 900),
};
/** how long an interaction is given to settle before the next read */
const SETTLE = Number(process.env.SETTLE ?? 650);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
const target = list.find((t) => t.type === "page");
if (!target) throw new Error(`no page target on CDP port ${PORT} — is headless Chrome running?`);
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
export const consoleErrors = [];
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  else if (m.method === "Runtime.exceptionThrown") consoleErrors.push(m.params.exceptionDetails.text);
  else if (m.method === "Log.entryAdded" && m.params.entry.level === "error") consoleErrors.push(m.params.entry.text);
};

export const send = (method, params = {}) => new Promise((res) => { pending.set(++id, res); ws.send(JSON.stringify({ id, method, params })); });

/** Evaluate an expression in the page and return it by value. Throws what the page threw. */
export const evl = async (x) => {
  const r = await send("Runtime.evaluate", { expression: x, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  return r.result?.value;
};

/** Expression finding an element by visible text or title, within a selector. */
export const q = (sel, text) =>
  `[...document.querySelectorAll(${JSON.stringify(sel)})].find(b => b.textContent.trim()===${JSON.stringify(text)} || b.getAttribute("title")===${JSON.stringify(text)})`;
/** Expression finding an element by aria-label — prefer this, it survives copy changes. */
export const qa = (label) => `document.querySelector('[aria-label=${JSON.stringify(label)}]')`;

export const exists = (text, sel = "button") => evl(`!!${q(sel, text)}`);

export const click = async (text, sel = "button") => {
  const ok = await evl(`(() => { const e = ${q(sel, text)}; if (!e) return false; e.click(); return true; })()`);
  if (!ok) throw new Error(`no ${sel} "${text}"`);
  await sleep(SETTLE);
};

export const clicka = async (label) => {
  const ok = await evl(`(() => { const e = ${qa(label)}; if (!e || e.disabled) return false; e.click(); return true; })()`);
  if (!ok) throw new Error(`no enabled [aria-label="${label}"]`);
  await sleep(SETTLE);
};

export const attr = (label, name) => evl(`${qa(label)}?.${name} ?? null`);
export const text = (label) => evl(`${qa(label)}?.textContent.trim() ?? null`);

export const key = async (k, code) => {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code: code ?? k, windowsVirtualKeyCode: 0 });
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: code ?? k });
  await sleep(SETTLE);
};

export async function nav(url, { settle = 3000 } = {}) {
  await send("Page.navigate", { url });
  await sleep(settle);
}

/** Navigate, clear storage, navigate again — a clean slate per artifact. */
export async function navFresh(url, opts) {
  await nav(url, opts);
  await evl("localStorage.clear()");
  await nav(url, opts);
}

export const results = {};

/**
 * Run one named check. A check proves its claim by throwing when it fails, and
 * returns a one-line detail when it passes — the detail is the evidence, so
 * make it carry numbers rather than the word "ok".
 */
export async function check(fid, fn) {
  try {
    const detail = await fn();
    results[fid] = { status: "PASS", detail: detail ?? "" };
  } catch (error) {
    results[fid] = { status: "FAIL", detail: String(error.message ?? error).slice(0, 160) };
  }
  console.log(fid, results[fid].status, results[fid].detail);
}

/** Enable the domains the helpers depend on and pin the viewport, before any page loads. */
export async function bootstrap() {
  await send("Runtime.enable");
  await send("Log.enable");
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 1, mobile: false });
}

/**
 * Emit the machine-readable line other tooling parses, then exit non-zero if
 * anything failed. A check runner that always exits 0 is useless in CI, which
 * is the difference between a script someone runs and a gate.
 */
export function report() {
  const failed = Object.entries(results).filter(([, r]) => r.status !== "PASS");
  console.log("RESULTS_JSON " + JSON.stringify(results));
  ws.close();
  process.exit(failed.length ? 1 : 0);
}
