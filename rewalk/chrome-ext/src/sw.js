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
const REC = { tabId: null, urlPattern: null, dir: null, voice: null };
let nativePort = null;
let boundTabId = null;
let startUrl = null;
let relayPorts = new Set();

const IDS = { main: 'rewalk-main', relay: 'rewalk-relay' };

// REC is a recording that asked for voice; DOM is one that did not. They are
// different things to be doing to somebody and the badge should not blur them.
function setBadge(on, voice) {
  chrome.action.setBadgeText({ text: on ? (voice === false ? 'DOM' : 'REC') : '' });
  if (on) chrome.action.setBadgeBackgroundColor({ color: voice === false ? '#d29922' : '#d11' });
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

// `voice` undefined means "whatever record.voice says in the config"; the
// host resolves it, because the config lives on that side of the pipe.
async function startSession(tab, { voice } = {}) {
  const pattern = patternFor(tab.url);
  if (!pattern) return;
  clearTimeout(relayGrace);
  REC.tabId = tab.id; REC.urlPattern = pattern; REC.dir = null; REC.voice = voice ?? null;
  startUrl = tab.url; boundTabId = null;
  try { openNative().postMessage({ control: 'start', url: startUrl, ...(voice === false ? { voice: false } : {}) }); } catch (e) {}
  await chrome.scripting.registerContentScripts([
    { id: IDS.main, matches: [pattern], js: ['src/boot.main.js'], runAt: 'document_start', world: 'MAIN', allFrames: false },
    { id: IDS.relay, matches: [pattern], js: ['src/relay.iso.js'], runAt: 'document_start', world: 'ISOLATED', allFrames: false },
  ]);
  // Confirm registration landed before the reload — the probe's race fix.
  await chrome.scripting.getRegisteredContentScripts({ ids: [IDS.main, IDS.relay] });
  await chrome.tabs.reload(tab.id);
  setBadge(true, voice);
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
  nativePort = null; boundTabId = null; REC.tabId = null; REC.urlPattern = null; REC.dir = null; REC.voice = null;
  setBadge(false);
}

// The toolbar button opens src/popup.html rather than starting a recording.
// One click used to mean "record this tab, and ask the daemon for the
// microphone", which made both of this product's real decisions invisible:
// whether to record at all, and whether to record voice. Commenting needs
// neither. chrome.action.onClicked does not fire while a default_popup is set,
// so the popup drives everything below through these messages.

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

// Show the panel FIRST, then fill in the session list. Asking the hub means
// starting the native host, which takes a beat; waiting for it before showing
// anything left the toolbar popup open with a dead button while a process
// started, and looked like nothing had happened.
async function toggleAnnotate(tab) {
  if (!tab?.id || !patternFor(tab.url)) return { ok: false, error: 'this page cannot be annotated' };
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [ANNOTATE_FILE], world: 'ISOLATED' });
  } catch (e) {
    return { ok: false, error: 'Chrome does not allow injection on this page' };
  }
  const state = { sessions: [], pending: true, recording: REC.tabId === tab.id ? { dir: REC.dir } : null };
  let opened;
  try { opened = await chrome.tabs.sendMessage(tab.id, { rewalk: 'annotate', state }); } catch (e) {}
  // Closing does not need a session list.
  if (opened && opened.on === false) return { ok: true };
  askNative({ control: 'sessions' }, 8000).then((res) => {
    chrome.tabs.sendMessage(tab.id, { rewalk: 'sessions', sessions: res?.sessions ?? [] }).catch(() => {});
  });
  return { ok: true };
}

chrome.commands?.onCommand.addListener(async (command) => {
  if (command !== 'annotate') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  toggleAnnotate(tab);
});

// The toolbar button records the way the config says (voice on by default).
// The menu carries the two things a button cannot: commenting with no
// recording at all, and recording the DOM without asking for a microphone —
// which is what most commenting actually wants, since a replay needs the DOM
// stream and nothing else.
const MENU = ['page', 'selection', 'link', 'image'];
chrome.runtime.onInstalled.addListener(() => {
  try {
    chrome.contextMenus.create({ id: 'rewalk-annotate', title: 'rewalk: comment on this page', contexts: MENU });
    chrome.contextMenus.create({ id: 'rewalk-rec-silent', title: 'rewalk: record this tab without voice', contexts: MENU });
  } catch (e) {}
});
chrome.contextMenus?.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'rewalk-annotate') toggleAnnotate(tab);
  if (info.menuItemId === 'rewalk-rec-silent') {
    if (REC.tabId == null) await startSession(tab, { voice: false });
    else await stopSession();
  }
});

// --- what the popup asks for -------------------------------------------------
const activeTab = async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0];

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  switch (msg?.rewalk) {
    case 'state':
      // sameTab matters: a recording belongs to one tab, so "stop" from
      // another tab's popup would end a recording the person is not looking
      // at, and a comment there could not be attached to it.
      activeTab().then((tab) => reply({
        recording: REC.tabId != null, voice: REC.voice, dir: REC.dir,
        sameTab: REC.tabId != null && !!tab && tab.id === REC.tabId,
      }));
      return true;
    case 'start':
      activeTab().then(async (tab) => { if (tab) await startSession(tab, { voice: msg.voice }); reply({ ok: true }); });
      return true;
    case 'stop':
      stopSession().then(() => reply({ ok: true }));
      return true;
    case 'annotate-active':
      activeTab().then(async (tab) => reply(await toggleAnnotate(tab)));
      return true;
  }
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
