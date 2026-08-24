// Service worker: the bridge between the page-side relay and the native host.
//
// One native port per session, opened on the first relay connection and kept
// alive by connectNative (documented strong keepalive) plus the 250ms batch
// traffic. Batches go relay -> native; the host's acks and HUD RMS come back
// native -> relay. If the host dies, the native port disconnects; the next
// batch reopens it, so a host crash costs only what was in flight, never the
// session.
//
// v1 records exactly one tab: the relay port carries its sender.tab.id, and
// only the first tab to connect is bound for the session. A second tab's
// batches are dropped rather than interleaved into one FullSnapshot lineage the
// readers assume.
const HOST = 'com.rewalk.host';
let nativePort = null;
let boundTabId = null;
let startUrl = null;
let relayPorts = new Set();

function openNative() {
  if (nativePort) return nativePort;
  nativePort = chrome.runtime.connectNative(HOST);
  try { nativePort.postMessage({ control: 'start', url: startUrl }); } catch (e) {}
  nativePort.onMessage.addListener((msg) => {
    if (msg && msg.hud != null)
      for (const p of relayPorts) { try { p.postMessage({ hud: msg.hud }); } catch (e) {} }
  });
  nativePort.onDisconnect.addListener(() => {
    nativePort = null;   // reopened lazily on the next batch
  });
  return nativePort;
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'rewalk') return;
  const tabId = port.sender && port.sender.tab && port.sender.tab.id;
  if (boundTabId == null) { boundTabId = tabId; startUrl = port.sender && port.sender.tab && port.sender.tab.url; }
  relayPorts.add(port);

  port.onMessage.addListener((msg) => {
    if (!msg || msg.batch == null) return;
    if (tabId !== boundTabId) return;             // one tab per session
    const np = openNative();
    try { np.postMessage({ batch: msg.batch }); } catch (e) { nativePort = null; }
  });
  port.onDisconnect.addListener(() => relayPorts.delete(port));
});
