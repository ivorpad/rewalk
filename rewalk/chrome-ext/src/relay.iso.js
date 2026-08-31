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

  // Set on the SW's stop broadcast. After this the relay is inert: no more
  // forwarding, no reconnecting — a stopped page must not be able to wake the
  // host back up. The MAIN world hears the same stop as a CustomEvent and
  // tears its instruments down.
  let stopped = false;

  let port = null;
  const connect = () => {
    try {
      port = chrome.runtime.connect({ name: 'rewalk' });
      port.onMessage.addListener((msg) => {
        if (msg && msg.stop) {
          stopped = true;
          try { port.disconnect(); } catch (e) {}
          port = null;
          document.dispatchEvent(new CustomEvent('__rewalk_stop'));
          return;
        }
        if (msg && msg.hud != null)
          document.dispatchEvent(new CustomEvent('__rewalk_hud', { detail: String(msg.hud) }));
        // Who this recording is going to. The HUD is in the MAIN world and
        // cannot reach chrome.runtime, so the list comes down this pipe and the
        // choice goes back up the one below.
        if (msg && msg.sessions)
          document.dispatchEvent(new CustomEvent('__rewalk_sessions', {
            detail: JSON.stringify({ sessions: msg.sessions, target: msg.target ?? null }),
          }));
      });
      port.onDisconnect.addListener(() => { port = null; });
    } catch (e) { port = null; }
  };
  connect();

  // The HUD's picker. Straight to the service worker rather than down the port:
  // it is the same message the comment overlay sends, and the worker is what
  // remembers a target per tab.
  document.addEventListener('__rewalk_target', (e) => {
    if (stopped) return;
    try { chrome.runtime.sendMessage({ rewalk: 'target', target: String(e.detail || '') || null }); } catch (x) {}
  });

  document.addEventListener('__rewalk_batch', (e) => {
    if (stopped) return;
    if (!port) connect();
    try { port && port.postMessage({ batch: e.detail }); }   // e.detail is already a JSON string
    catch (x) { port = null; }
  });
})();
