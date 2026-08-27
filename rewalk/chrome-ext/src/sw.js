// Service worker: on-demand recording, one tab, zero standing footprint.
//
// Nothing is injected into any page until you click the toolbar button. That
// click registers the two content scripts (MAIN-world recorder + ISOLATED
// relay) scoped to the chosen tab, then reloads it so document_start injection
// catches the full page load. This register-then-reload path is the one the
// probe measured at 5/5 including the first load — dynamic MAIN-world
// registration otherwise races the first navigation and silently records
// nothing. Clicking again stops: unregister, drop the native port, the host
// finalizes.
//
// One tab per session by construction: registration is scoped to the tab's URL
// and the SW binds the first relay that connects. The readers assume one
// FullSnapshot lineage; multi-tab is a reader change, not a transport one.
//
// The second, independent job is COMMENTS. Those work on any page whether or
// not a recording is running, so they get their own injection (executeScript
// into the active tab, on the keyboard command or the context menu) and their
// own use of the native port. The port is shared but the meanings are not: a
// recording sends control:start and owns the host's session directory, a
// comment never does and leaves the host idle.
const HOST = 'com.rewalk.host';
const REC = { tabId: null, urlPattern: null, dir: null };
let nativePort = null;
let boundTabId = null;
let startUrl = null;
let relayPorts = new Set();

const IDS = { main: 'rewalk-main', relay: 'rewalk-relay' };

function setBadge(on) {
  chrome.action.setBadgeText({ text: on ? 'REC' : '' });
  if (on) chrome.action.setBadgeBackgroundColor({ color: '#d11' });
}

// --- the native port ---------------------------------------------------------
// Opening it no longer means "a recording is starting". The host stays idle
// until it receives control:start, so a comment on a page nobody is recording
// costs a pipe and nothing else — no session directory, no voice request, no
// microphone. Replies are routed by `rid` back to whoever asked.
let rid = 0;
const pending = new Map();

function openNative() {
  if (nativePort) return nativePort;
  nativePort = chrome.runtime.connectNative(HOST);
  nativePort.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.rid != null && pending.has(msg.rid)) {
      const done = pending.get(msg.rid);
      pending.delete(msg.rid);
      done(msg);
      return;
    }
    // The host names the session directory once a recording begins, so a
    // comment written mid-recording can say which recording it belongs to.
    if (msg.recording?.dir) { REC.dir = msg.recording.dir; return; }
    if (msg.hud != null)
      for (const p of relayPorts) { try { p.postMessage({ hud: msg.hud }); } catch (e) {} }
  });
  nativePort.onDisconnect.addListener(() => {
    nativePort = null;
    for (const [, done] of pending) done(null);
    pending.clear();
  });
  return nativePort;
}

/** One request, one reply. Resolves null when the host is unreachable. */
function askNative(msg, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let port;
    try { port = openNative(); } catch (e) { return resolve(null); }
    const id = ++rid;
    const timer = setTimeout(() => { pending.delete(id); resolve(null); }, timeoutMs);
    pending.set(id, (reply) => { clearTimeout(timer); resolve(reply); });
    try { port.postMessage({ ...msg, rid: id }); }
    catch (e) { clearTimeout(timer); pending.delete(id); nativePort = null; resolve(null); }
  });
}

// URL -> a match pattern for that page. Scheme + host + "/*": tight enough that
// idle tabs on other sites are never touched, loose enough to survive in-page
// navigations on the same origin during the session.
function patternFor(url) {
  try { const u = new URL(url); return `${u.protocol}//${u.host}/*`; }
  catch (e) { return null; }
}

async function startSession(tab) {
  const pattern = patternFor(tab.url);
  if (!pattern) return;
  clearTimeout(relayGrace);
  REC.tabId = tab.id; REC.urlPattern = pattern; REC.dir = null; startUrl = tab.url; boundTabId = null;
  try { openNative().postMessage({ control: 'start', url: startUrl }); } catch (e) {}
  await chrome.scripting.registerContentScripts([
    { id: IDS.main, matches: [pattern], js: ['src/boot.main.js'], runAt: 'document_start', world: 'MAIN', allFrames: false },
    { id: IDS.relay, matches: [pattern], js: ['src/relay.iso.js'], runAt: 'document_start', world: 'ISOLATED', allFrames: false },
  ]);
  // Confirm registration landed before the reload — the probe's race fix.
  await chrome.scripting.getRegisteredContentScripts({ ids: [IDS.main, IDS.relay] });
  await chrome.tabs.reload(tab.id);
  setBadge(true);
}

async function stopSession() {
  clearTimeout(relayGrace);
  // Tear-down order matters: tell the page first, so the instruments remove
  // themselves and rrweb stops emitting, THEN drop the ports. Unregistering
  // alone leaves the injected recorder running until the next navigation —
  // measured as a highlight ring still chasing the mouse after stop. The tail
  // batch inside the last 250ms is forfeit, the same exposure kill -9 costs.
  for (const p of relayPorts) { try { p.postMessage({ stop: true }); } catch (e) {} }
  for (const p of relayPorts) { try { p.disconnect(); } catch (e) {} }
  relayPorts.clear();
  try { await chrome.scripting.unregisterContentScripts({ ids: [IDS.main, IDS.relay] }); } catch (e) {}
  try { if (nativePort) nativePort.disconnect(); } catch (e) {}   // stdin closes -> host finalizes
  nativePort = null; boundTabId = null; REC.tabId = null; REC.urlPattern = null; REC.dir = null;
  setBadge(false);
}

chrome.action.onClicked.addListener(async (tab) => {
  if (REC.tabId == null) await startSession(tab);
  else await stopSession();
});

// The session must not outlive the page it records. Three ways a page dies
// without tabs.onRemoved firing — cross-origin navigation, Memory Saver
// discarding the tab, a renderer crash — all leave the relay dead while the
// native port (and the microphone behind it) stays open. Measured: one such
// session recorded 10 hours of room audio. So: close on tab close, close on
// navigation off the recorded origin, and close when every relay has been
// gone for a grace period long enough to cover a same-origin reload.
chrome.tabs.onRemoved.addListener((tabId) => { if (tabId === REC.tabId) stopSession(); });
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (tabId !== REC.tabId || !change.url) return;
  if (patternFor(change.url) !== REC.urlPattern) stopSession();
});

const RELAY_GRACE_MS = 30_000;
let relayGrace = null;
function armRelayGrace() {
  clearTimeout(relayGrace);
  relayGrace = setTimeout(() => {
    if (REC.tabId != null && relayPorts.size === 0) stopSession();
  }, RELAY_GRACE_MS);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'rewalk') return;
  const tabId = port.sender && port.sender.tab && port.sender.tab.id;
  // No live session, no port. A page still instrumented after stop would
  // otherwise reconnect on its next batch and openNative() would start a
  // fresh host session — a microphone running with the badge off, the exact
  // class of runaway the tab-death handlers below exist to prevent.
  if (REC.tabId == null || tabId !== REC.tabId) return;
  if (boundTabId == null) boundTabId = tabId;
  relayPorts.add(port);
  clearTimeout(relayGrace);
  port.onMessage.addListener((msg) => {
    if (!msg || msg.batch == null) return;
    if (tabId !== boundTabId) return;
    const np = openNative();
    try { np.postMessage({ batch: msg.batch }); } catch (e) { nativePort = null; }
  });
  port.onDisconnect.addListener(() => {
    relayPorts.delete(port);
    if (relayPorts.size === 0 && REC.tabId != null) armRelayGrace();
  });
});

// --- comments ----------------------------------------------------------------
// The overlay is injected on demand into the active tab, the same "nothing
// until you ask" rule the recorder follows. Injecting twice is harmless: the
// script guards on window.__rewalkAnnotate and the second injection only
// toggles it.
const ANNOTATE_FILE = 'src/annotate.iso.js';

async function toggleAnnotate(tab) {
  if (!tab?.id || !patternFor(tab.url)) return;
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [ANNOTATE_FILE], world: 'ISOLATED' });
  } catch (e) { return; }   // chrome:// pages and the web store refuse injection
  const res = await askNative({ control: 'sessions' }, 6000);
  const state = {
    sessions: res?.sessions ?? [],
    recording: REC.tabId === tab.id ? { dir: REC.dir } : null,
  };
  try { await chrome.tabs.sendMessage(tab.id, { rewalk: 'annotate', state }); } catch (e) {}
}

chrome.commands?.onCommand.addListener(async (command) => {
  if (command !== 'annotate') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  toggleAnnotate(tab);
});

chrome.runtime.onInstalled.addListener(() => {
  try {
    chrome.contextMenus.create({ id: 'rewalk-annotate', title: 'rewalk: comment on this page',
      contexts: ['page', 'selection', 'link', 'image'] });
  } catch (e) {}
});
chrome.contextMenus?.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'rewalk-annotate') toggleAnnotate(tab);
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.rewalk !== 'comment') return false;
  const tabId = sender.tab?.id;
  const recordingHere = REC.tabId != null && tabId === REC.tabId;
  const comment = {
    kind: 'rewalk.comment.v1',
    text: msg.payload?.text ?? '',
    nodes: msg.payload?.nodes ?? [],
    page: msg.payload?.page ?? {},
    // A comment written during a recording names that recording, and is held
    // by the hub until it finishes — its artifacts do not exist yet.
    session: recordingHere && REC.dir ? { dir: REC.dir, recording: true } : null,
    target: msg.payload?.target ?? null,
    where: {},
    createdWall: Date.now(),
  };
  askNative({ comment }).then(async (res) => {
    // Send finalizes the recording: the person is done, and the comment's
    // whole value is the session it names. Queue first, THEN stop — stopping
    // first would drop the native port this request is travelling on.
    if (res?.ok && recordingHere) await stopSession();
    reply(res ?? { ok: false, error: 'the native host is not installed or did not answer' });
  });
  return true;   // reply is async
});
