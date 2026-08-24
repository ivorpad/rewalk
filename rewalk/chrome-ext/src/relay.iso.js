// ISOLATED-world relay. The MAIN world cannot reach chrome.runtime, so this
// content script is the only thing that can carry batches to the service
// worker. It listens for the CustomEvents boot.main.js dispatches on document,
// forwards them over a long-lived Port, and pushes the host's HUD level back
// the same way.
//
// Runs at document_start too, so the port exists before the first batch. If the
// SW is asleep, connect() wakes it; if the port drops (SW recycled), reconnect
// and keep going — the batches queue in the MAIN-world buffer meanwhile, which
// is the same 250ms exposure the CLI already accepts.
(() => {
  if (window.__rewalkRelay) return;
  window.__rewalkRelay = 1;

  let port = null;
  const connect = () => {
    try {
      port = chrome.runtime.connect({ name: 'rewalk' });
      port.onMessage.addListener((msg) => {
        if (msg && msg.hud != null)
          document.dispatchEvent(new CustomEvent('__rewalk_hud', { detail: String(msg.hud) }));
      });
      port.onDisconnect.addListener(() => { port = null; });
    } catch (e) { port = null; }
  };
  connect();

  document.addEventListener('__rewalk_batch', (e) => {
    if (!port) connect();
    try { port && port.postMessage({ batch: e.detail }); }   // e.detail is already a JSON string
    catch (x) { port = null; }
  });
})();
