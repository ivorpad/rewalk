// The recording indicator. Injected only when a human is being recorded.
//
// Written because the person in the very first real-app session asked, mid
// recording, "how do i start talking" -- the recorder gave them nothing: no
// sign the mic was live, no hint that alt-click points, no confirmation a mark
// landed. All feedback went to a terminal they were not looking at. A 444s
// session with zero clicks and a first minute of narration with no marks are
// the measured cost.
//
// Two design constraints that are not cosmetic:
//
// 1. The level shown is computed by the HOST from the bytes ffmpeg has already
//    written to disk, pushed in via __rewalkHudLevel. The page could ask
//    getUserMedia for its own meter, but that can open a DIFFERENT device and
//    show a healthy level while the real capture records a dead one -- the
//    "frames arriving proves nothing" trap with a UI on it. This meter cannot
//    say yes unless the recording itself heard something.
//
// 2. The HUD must be invisible to every instrument. class="rr-block" keeps
//    rrweb from serialising it; tick.js and deltas.mjs exclude #rewalk-hud
//    explicitly; and it uses NO css transitions or animations, because
//    motion.js discovers work through transition events and getAnimations()
//    and must not discover the meter. Styles are set directly, once per push.
(() => {
  if (window.__rewalkHud || location.href === 'about:blank') return;
  window.__rewalkHud = 1;

  const mk = (tag, css) => { const el = document.createElement(tag); el.style.cssText = css; return el; };
  const root = mk('div',
    'position:fixed;right:14px;bottom:14px;z-index:2147483647;pointer-events:none;' +
    'font:12px/1.4 ui-sans-serif,system-ui,sans-serif;color:#e6edf3;' +
    'background:rgba(14,17,22,.92);border:1px solid #2a323d;border-radius:8px;' +
    'padding:8px 12px;display:flex;align-items:center;gap:9px;min-width:230px');
  root.id = 'rewalk-hud';
  root.className = 'rr-block';

  const dot = mk('span', 'width:9px;height:9px;border-radius:50%;background:#f85149;flex:none');
  const meter = mk('span', 'position:relative;width:52px;height:8px;border-radius:4px;background:#2a323d;overflow:hidden;flex:none');
  const fill = mk('span', 'position:absolute;left:0;top:0;bottom:0;width:0;background:#3fb950;border-radius:4px');
  meter.appendChild(fill);
  const label = mk('span', 'white-space:nowrap');
  label.textContent = 'rec — speak as you go · ⌥-click to point';
  const toast = mk('div',
    'position:fixed;right:14px;bottom:52px;z-index:2147483647;pointer-events:none;' +
    'font:12px ui-sans-serif,system-ui,sans-serif;color:#0e1116;background:#3fb950;' +
    'border-radius:6px;padding:5px 10px;opacity:0;max-width:340px;white-space:nowrap;' +
    'overflow:hidden;text-overflow:ellipsis');
  toast.id = 'rewalk-hud-toast';
  toast.className = 'rr-block';

  const attach = () => { document.body.appendChild(root); document.body.appendChild(toast); };
  document.body ? attach() : addEventListener('DOMContentLoaded', attach);

  root.appendChild(dot); root.appendChild(meter); root.appendChild(label);

  // Host pushes the RMS of the most recent quarter second actually on disk.
  // No pushes at all means the host loop died: say so rather than sit green.
  // The silence alarm compares against when something was last HEARD, not when
  // the host last REPORTED. The first version compared against lastPush, which
  // refreshes every 300ms while the host dutifully reports silence -- so the
  // one state this exists for could never fire. Caught by driving 16s of
  // near-zero levels and watching the label not change.
  let firstPush = 0, lastPush = 0, lastHeard = 0;
  window.__rewalkHudLevel = (rms) => {
    lastPush = Date.now();
    if (!firstPush) firstPush = lastPush;
    const pct = Math.min(1, Math.sqrt(Math.max(0, rms) / 0.25));
    fill.style.width = (pct * 100).toFixed(0) + '%';
    if (rms > 0.008) lastHeard = Date.now();
  };

  const statusTimer = setInterval(() => {
    const now = Date.now();
    const quietFor = lastHeard ? now - lastHeard : (firstPush ? now - firstPush : 0);
    if (!lastPush || now - lastPush > 4000) {
      dot.style.background = '#f85149';
      label.textContent = 'recorder not reporting — is the session still running?';
    } else if (lastHeard && now - lastHeard < 2000) {
      dot.style.background = '#3fb950';
      label.textContent = 'hearing you · ⌥-click to point';
    } else if (quietFor > 15000) {
      dot.style.background = '#f85149';
      label.textContent = 'mic hears nothing — check input / permission';
    } else {
      dot.style.background = '#d29922';
      label.textContent = 'rec — speak as you go · ⌥-click to point';
    }
  }, 500);

  // Confirm a point landed, with what it landed on. Same capture phase as the
  // mark handler in tick.js, so the two cannot disagree about the target.
  let toastTimer = null;
  addEventListener('click', (e) => {
    if (!e.altKey) return;
    const el = e.target && e.target.nodeType === 1 ? e.target : null;
    if (!el || root.contains(el)) return;
    const name = el.getAttribute?.('aria-label') ?? (el.id ? '#' + el.id : null) ??
      (el.textContent || '').trim().slice(0, 40) ?? el.tagName?.toLowerCase() ?? 'element';
    toast.textContent = '✓ pointed at ' + name;
    toast.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.style.opacity = '0'; }, 1600);
  }, true);

  // Recording stopped on purpose: leave the page as it was found. The
  // "recorder not reporting" warning is for a session that DIED, not one the
  // person ended.
  document.addEventListener('__rewalk_stop', () => {
    clearInterval(statusTimer);
    clearTimeout(toastTimer);
    window.__rewalkHudLevel = () => {};
    try { root.remove(); toast.remove(); } catch (e) {}
  }, { once: true });
})();
