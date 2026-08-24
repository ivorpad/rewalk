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
const HOST = 'com.rewalk.host';
const REC = { tabId: null, urlPattern: null };
let nativePort = null;
let boundTabId = null;
let startUrl = null;
let relayPorts = new Set();

const IDS = { main: 'rewalk-main', relay: 'rewalk-relay' };

function setBadge(on) {
  chrome.action.setBadgeText({ text: on ? 'REC' : '' });
  if (on) chrome.action.setBadgeBackgroundColor({ color: '#d11' });
}

function openNative() {
  if (nativePort) return nativePort;
  nativePort = chrome.runtime.connectNative(HOST);
  try { nativePort.postMessage({ control: 'start', url: startUrl }); } catch (e) {}
  nativePort.onMessage.addListener((msg) => {
    if (msg && msg.hud != null)
      for (const p of relayPorts) { try { p.postMessage({ hud: msg.hud }); } catch (e) {} }
  });
  nativePort.onDisconnect.addListener(() => { nativePort = null; });
  return nativePort;
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
  REC.tabId = tab.id; REC.urlPattern = pattern; startUrl = tab.url; boundTabId = null;
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
  try { await chrome.scripting.unregisterContentScripts({ ids: [IDS.main, IDS.relay] }); } catch (e) {}
  try { if (nativePort) nativePort.disconnect(); } catch (e) {}   // stdin closes -> host finalizes
  nativePort = null; boundTabId = null; REC.tabId = null; REC.urlPattern = null;
  setBadge(false);
}

chrome.action.onClicked.addListener(async (tab) => {
  if (REC.tabId == null) await startSession(tab);
  else await stopSession();
});

// A recording tab that navigates away or closes ends the session cleanly.
chrome.tabs.onRemoved.addListener((tabId) => { if (tabId === REC.tabId) stopSession(); });

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'rewalk') return;
  const tabId = port.sender && port.sender.tab && port.sender.tab.id;
  if (REC.tabId != null && tabId !== REC.tabId) return;   // ignore anything but the recording tab
  if (boundTabId == null) boundTabId = tabId;
  relayPorts.add(port);
  port.onMessage.addListener((msg) => {
    if (!msg || msg.batch == null) return;
    if (tabId !== boundTabId) return;
    const np = openNative();
    try { np.postMessage({ batch: msg.batch }); } catch (e) { nativePort = null; }
  });
  port.onDisconnect.addListener(() => relayPorts.delete(port));
});
