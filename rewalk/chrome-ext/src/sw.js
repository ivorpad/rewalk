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

const IDS = { main: 'rewalk-main', lens: 'rewalk-lens', relay: 'rewalk-relay' };

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
  // Kill, THEN start. Beginning a recording is an affirmative act, so whatever
  // came before has to be finished first rather than left to a tab-death
  // handler that may never fire: a recording in another tab, a native host
  // still holding the last session's directory open, a relay port from a page
  // that navigated. stopSession tells the page, drops the ports (the host
  // finalizes on stdin close) and clears REC, so everything below builds on a
  // clean floor instead of inheriting half of a session nobody asked for.
  if (REC.tabId != null) await stopSession();
  clearTimeout(relayGrace);
  REC.tabId = tab.id; REC.urlPattern = pattern; REC.dir = null; REC.voice = voice ?? null;
  startUrl = tab.url; boundTabId = null;
  try { openNative().postMessage({ control: 'start', url: startUrl, ...(voice === false ? { voice: false } : {}) }); } catch (e) {}
  // Clear our own ids first. registerContentScripts THROWS on a duplicate id,
  // and a registration outlives the worker that made it, so one recording that
  // ended the wrong way used to poison every later start: the native host was
  // told to begin, this function died on the throw before it could inject or
  // reload, and the popup had already closed itself. No HUD, no lens, no DOM
  // stream, no error anywhere — just a mic running for a session that was not
  // recording anything.
  try { await chrome.scripting.unregisterContentScripts({ ids: Object.values(IDS) }); } catch (e) {}
  await chrome.scripting.registerContentScripts([
    // The recorder: TOP FRAME ONLY. rrweb's iframe manager already traverses
    // same-origin children (measured: 15 of 15 mutations inside a child tracked
    // from here), and a second rrweb.record() in the same tab would write two
    // streams into one file.
    { id: IDS.main, matches: [pattern], js: ['src/boot.main.js'], runAt: 'document_start', world: 'MAIN', allFrames: false, persistAcrossSessions: false },
    // The lens: EVERY frame. Rings are drawn from getBoundingClientRect, which
    // is per-frame, so no other frame can ring anything inside a story. It also
    // carries the fiber walk and the child->top mark relay, because events do
    // not cross a frame boundary and clicks inside an iframe were recording
    // nothing at all.
    { id: IDS.lens, matches: [pattern], js: ['src/lens.main.js'], runAt: 'document_start', world: 'MAIN', allFrames: true, persistAcrossSessions: false },
    { id: IDS.relay, matches: [pattern], js: ['src/relay.iso.js'], runAt: 'document_start', world: 'ISOLATED', allFrames: false, persistAcrossSessions: false },
  ]);
  // Confirm registration landed before the reload — the probe's race fix.
  await chrome.scripting.getRegisteredContentScripts({ ids: [IDS.main, IDS.lens, IDS.relay] });
  await chrome.tabs.reload(tab.id);
  setBadge(true, voice);
  return { ok: true };
}

/**
 * startSession, with the failure made visible.
 *
 * Everything above can throw — a duplicate id, a file the build did not write,
 * a page Chrome will not inject into — and the popup closes itself the moment
 * it gets a reply, so a throw that nobody catches reads as "I pressed Record
 * and nothing happened". Roll the native host back too: a half-started session
 * is a microphone that is live for a recording that does not exist.
 */
async function startSessionSafely(tab, opts) {
  try {
    return await startSession(tab, opts);
  } catch (e) {
    try { await chrome.scripting.unregisterContentScripts({ ids: Object.values(IDS) }); } catch (x) {}
    try { if (nativePort) nativePort.disconnect(); } catch (x) {}
    nativePort = null;
    REC.tabId = null; REC.urlPattern = null; REC.dir = null; REC.voice = null;
    setBadge(false);
    console.error('[rewalk] could not start recording', e);
    return { ok: false, error: `could not start recording: ${e?.message ?? e}` };
  }
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
  try { await chrome.scripting.unregisterContentScripts({ ids: [IDS.main, IDS.lens, IDS.relay] }); } catch (e) {}
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
  // The HUD in this page has a picker and nothing in it yet. Fill it, and tell
  // the host the same answer, so a recording that nobody touches still has a
  // destination when it finishes.
  sessionsFor(tabId).then(({ sessions, target }) => pushTarget(tabId, sessions, target)).catch(() => {});
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

// --- where a comment goes, remembered per TAB --------------------------------
// The picker's choice used to be a variable inside the content script, so it
// died with the overlay, with the page, and with this worker. Pick a session,
// comment, reload, comment again, and the second one went wherever the hub
// happened to list first.
//
// Per TAB, not globally: two tabs open on two apps are very often two different
// agent sessions, and a global "last used" would send the second tab's comment
// to the first tab's agent.
//
// A THIRD lifetime, on top of the two that already disagree here (registrations
// outlive the browser, REC dies with the worker), so say plainly how it ends:
//   - the worker restarting     it does not — storage.session survives that
//   - the tab closing           onRemoved below drops the key
//   - the browser restarting    storage.session is gone by definition, and a
//                               tab id means nothing after a restart anyway
//   - the session dying         resolved against the live list on every read,
//                               below, and never left as a dead selection
// storage.session also never touches disk, which a list of what somebody was
// commenting on should not.
const targetKey = (tabId) => `target:${tabId}`;

async function rememberTarget(tabId, sessionId) {
  if (tabId == null) return;
  try {
    if (sessionId) await chrome.storage.session.set({ [targetKey(tabId)]: sessionId });
    else await chrome.storage.session.remove(targetKey(tabId));
  } catch (e) {}
}

async function rememberedTarget(tabId) {
  if (tabId == null) return null;
  try { return (await chrome.storage.session.get(targetKey(tabId)))[targetKey(tabId)] ?? null; }
  catch (e) { return null; }
}

/**
 * Which session this tab's next comment goes to, most specific first:
 *
 *   1. the one it was last sent to, IF that session is still live
 *   2. sessions[0] — the hub's order, most recently active
 *
 * A remembered target that has died must fall through, not sit there selected.
 * The hub refuses to route to a dead session, so honouring one would produce a
 * comment queued for ever that looked exactly like a comment that was sent —
 * the failure lib/comment.mjs and the hub were fixed for on 2026-08-26.
 * Whatever wins is written straight back, so the fallthrough is remembered too.
 *
 * An EMPTY list is not evidence that anything died. askNative resolves null
 * when the host is not installed, not running, or slow past its timeout, and
 * all three arrive here as []. Treating that as "your session is gone" would
 * let a hub restart quietly forget what every open tab was pointed at.
 */
async function resolveTarget(tabId, sessions) {
  const remembered = await rememberedTarget(tabId);
  if (!sessions.length) return remembered;
  const live = sessions.find((s) => s && s.session_id === remembered);
  const chosen = live?.session_id ?? sessions[0]?.session_id ?? null;
  if (chosen !== remembered) await rememberTarget(tabId, chosen);
  return chosen;
}

// A tab id is reused by Chrome, so a key left behind by a closed tab is not
// merely garbage — it is a wrong answer waiting for the next tab to inherit it.
chrome.tabs.onRemoved.addListener((tabId) => { rememberTarget(tabId, null); });

/** The live list plus this tab's resolved choice, and why not, if not. */
async function sessionsFor(tabId) {
  const res = await askNative({ control: 'sessions' }, 8000);
  const sessions = res?.sessions ?? [];
  // "Nobody is running" and "I could not ask" look identical to an empty list,
  // and the panel used to render both as "no agent session is running" — a lie
  // when the host is missing or the hub did not answer, leaving the only
  // visible symptom as a picker that will not open.
  const error = res
    ? (res.ok === false ? (res.error ?? 'the hub refused to list sessions') : null)
    : 'the rewalk native host did not answer — is it installed?';
  return { sessions, error, target: await resolveTarget(tabId, sessions) };
}

/**
 * Tell the recording HUD where this recording is going, and tell the host too.
 *
 * The host is the one that files the finished session, and it does so from
 * inside finalize() — after this worker has already dropped the port. So it has
 * to be holding the answer before then, not asked for it at the end.
 */
async function pushTarget(tabId, sessions, target) {
  if (REC.tabId == null || tabId !== REC.tabId) return;
  for (const p of relayPorts) { try { p.postMessage({ sessions, target }); } catch (e) {} }
  try { openNative().postMessage({ control: 'target', target: target ?? null }); } catch (e) {}
}

// --- comments ----------------------------------------------------------------
// The overlay is injected on demand into the active tab, the same "nothing
// until you ask" rule the recorder follows. Injecting twice is harmless: the
// script guards on window.__rewalkAnnotate and the second injection only
// toggles it.
const ANNOTATE_FILE = 'src/annotate.iso.js';
const LENS_FILE = 'src/lens.main.js';

// Show the panel FIRST, then fill in the session list. Asking the hub means
// starting the native host, which takes a beat; waiting for it before showing
// anything left the toolbar popup open with a dead button while a process
// started, and looked like nothing had happened.
async function toggleAnnotate(tab) {
  if (!tab?.id || !patternFor(tab.url)) return { ok: false, error: 'this page cannot be annotated' };
  try {
    // Every frame, not just the top one. A Storybook story, a docs preview, an
    // embedded editor — the thing worth commenting on is usually inside an
    // iframe, and from the top frame that whole region is a single <iframe>
    // element, so a click there selected the frame instead of the button in
    // it. Each frame gets a selection surface; only the top one draws a panel.
    // The overlay itself, in the ISOLATED world because it needs chrome.runtime.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true }, files: [ANNOTATE_FILE], world: 'ISOLATED',
    });
    // And the MAIN-world half, for the fiber walk. The comment overlay cannot
    // reach a MAIN-world function, so without this a comment ships react: null
    // while the ring beside it names the component — a bare selector an agent
    // could have produced itself from devtools. The lens driver in this bundle
    // stays dark: it only arms while a recording is running, and asking for a
    // comment is not that. Harmless if a recording already registered it.
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true }, files: [LENS_FILE], world: 'MAIN',
      });
    } catch (e) {}
  } catch (e) {
    return { ok: false, error: 'Chrome does not allow injection on this page' };
  }
  const state = {
    sessions: [], pending: true, target: await rememberedTarget(tab.id),
    recording: REC.tabId === tab.id ? { dir: REC.dir } : null,
  };
  let opened;
  // No frameId: this reaches every frame. The top frame's answer is the one
  // that says whether the toggle opened or closed.
  try {
    const all = await chrome.tabs.sendMessage(tab.id, { rewalk: 'annotate', state });
    opened = Array.isArray(all) ? all.find((r) => r && r.top) : all;
  } catch (e) {}
  // Closing does not need a session list.
  if (opened && opened.on === false) return { ok: true };
  // Resolved in the worker, not in the page: this is the only thing that knows
  // which tab asked, and the content script stays a view of the answer.
  sessionsFor(tab.id).then(({ sessions, target, error }) => {
    chrome.tabs.sendMessage(tab.id, { rewalk: 'sessions', sessions, target, error }, { frameId: 0 }).catch(() => {});
    pushTarget(tab.id, sessions, target);
  });
  return { ok: true };
}

// Frames cannot talk to each other, and the service worker is the only thing
// that can talk to all of them. A pick made in an iframe goes up to the top
// frame's panel; a removal from that panel goes back down to whichever frame
// owns the ring.
function relayFrames(msg, sender) {
  const tabId = sender.tab?.id;
  if (tabId == null) return;
  const toTop = (m) => chrome.tabs.sendMessage(tabId, m, { frameId: 0 }).catch(() => {});
  const toAll = (m) => chrome.tabs.sendMessage(tabId, m).catch(() => {});
  if (msg.rewalk === 'pick') toTop({ rewalk: 'peer-pick', node: msg.node });
  if (msg.rewalk === 'unpick') toTop({ rewalk: 'peer-unpick', key: msg.key });
  if (msg.rewalk === 'drop') toAll({ rewalk: 'drop', key: msg.key });
  if (msg.rewalk === 'close') toAll({ rewalk: 'close' });
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
// Nothing rewalk registers may survive the session that asked for it.
//
// registerContentScripts defaults to persistAcrossSessions:true, and REC lives
// only in this worker's memory. So a recording that ended the wrong way — the
// browser closed on it, the worker killed — left boot.main.js registered
// against that origin with nothing tracking it, and every later page load on
// that site was silently instrumented: the HUD, the lens, and rrweb emitting
// into a native host that was not there. Nobody tapped anything.
//
// persistAcrossSessions:false stops it happening again; this sweep clears the
// registrations already written to disk. Both hooks are moments when no
// recording can be in flight (a live one holds a relay port open, which is what
// keeps this worker alive), so it can never unregister a session in progress.
const sweepStale = async (why) => {
  try {
    const live = await chrome.scripting.getRegisteredContentScripts();
    const ours = live.filter((s) => Object.values(IDS).includes(s.id)).map((s) => s.id);
    if (!ours.length) return;
    await chrome.scripting.unregisterContentScripts({ ids: ours });
    console.log(`[rewalk] cleared ${ours.length} orphaned content script(s) at ${why}`);
  } catch (e) {}
};
chrome.runtime.onStartup.addListener(() => sweepStale('browser start'));

const MENU = ['page', 'selection', 'link', 'image'];
chrome.runtime.onInstalled.addListener(() => {
  sweepStale('extension load');
  try {
    chrome.contextMenus.create({ id: 'rewalk-annotate', title: 'rewalk: comment on this page', contexts: MENU });
    chrome.contextMenus.create({ id: 'rewalk-rec-silent', title: 'rewalk: record this tab without voice', contexts: MENU });
  } catch (e) {}
});
chrome.contextMenus?.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'rewalk-annotate') toggleAnnotate(tab);
  if (info.menuItemId === 'rewalk-rec-silent') {
    // The context menu has nowhere to show an error, so at least do not leave a
    // half-started session behind when one happens.
    if (REC.tabId == null) await startSessionSafely(tab, { voice: false });
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
      activeTab().then(async (tab) => {
        if (!tab) { reply({ ok: false, error: 'no active tab' }); return; }
        reply(await startSessionSafely(tab, { voice: msg.voice }));
      });
      return true;
    case 'stop':
      stopSession().then(() => reply({ ok: true }));
      return true;
    case 'annotate-active':
      activeTab().then(async (tab) => reply(await toggleAnnotate(tab)));
      return true;
    case 'pick': case 'unpick': case 'drop': case 'close':
      relayFrames(msg, sender);
      return false;
    // The person changed the picker. Remembered the moment it changes, not on
    // send: a choice made and then cancelled is still what they meant by this
    // tab, and the next comment from it should open on that session.
    case 'target': {
      const id = sender.tab?.id;
      rememberTarget(id, msg.target || null);
      // Mid-recording, the host has to learn it too: it files the finished
      // session from finalize(), long after this worker has let go.
      if (REC.tabId != null && id === REC.tabId) {
        try { openNative().postMessage({ control: 'target', target: msg.target || null }); } catch (e) {}
      }
      return false;
    }
  }
  if (msg?.rewalk !== 'comment') return false;
  const tabId = sender.tab?.id;
  (async () => {
    const recordingHere = REC.tabId != null && tabId === REC.tabId;
    // The panel's choice, or — if it somehow shipped without one — this tab's
    // remembered session, so a comment is never sent with no route at all.
    const target = msg.payload?.target ?? await rememberedTarget(tabId);
    await rememberTarget(tabId, target);
    const comment = {
      kind: 'rewalk.comment.v1',
      text: msg.payload?.text ?? '',
      nodes: msg.payload?.nodes ?? [],
      page: msg.payload?.page ?? {},
      // A comment written during a recording names that recording, and is held
      // by the hub until it finishes — its artifacts do not exist yet.
      session: recordingHere && REC.dir ? { dir: REC.dir, recording: true } : null,
      target: target ?? null,
      where: {},
      createdWall: Date.now(),
    };
    const res = await askNative({ comment });
    // Send finalizes the recording: the person is done, and the comment's
    // whole value is the session it names. Queue first, THEN stop — stopping
    // first would drop the native port this request is travelling on.
    if (res?.ok && recordingHere) await stopSession();
    reply(res ?? { ok: false, error: 'the native host is not installed or did not answer' });
  })();
  return true;   // reply is async
});
