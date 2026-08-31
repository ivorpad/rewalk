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

  // --- where this recording is going -----------------------------------------
  // A recording produces a session directory, and until now nothing said who it
  // was for: the picker lived in the comment overlay, so a recording with ⌥
  // points and voice and no typed comment had no destination at all. The HUD is
  // on screen for the whole recording, so the answer belongs here — visible the
  // entire time, changeable at any point in it.
  //
  // The list arrives from the ISOLATED world (relay.iso.js), because reaching
  // the service worker needs chrome.runtime and this file cannot. Same DOM
  // channel everything else between the two worlds uses.
  const sep = mk('span', 'width:1px;height:14px;background:#2a323d;flex:none');
  const pick = mk('button',
    'all:unset;pointer-events:auto;cursor:pointer;color:#a5adff;white-space:nowrap;' +
    'max-width:190px;overflow:hidden;text-overflow:ellipsis;font:12px/1.4 inherit');
  const menu = mk('div',
    'position:absolute;right:0;bottom:calc(100% + 8px);pointer-events:auto;min-width:230px;max-width:320px;' +
    'max-height:40vh;overflow:auto;background:#0e1116;border:1px solid #2a323d;border-radius:8px;' +
    'padding:4px;display:none;box-shadow:0 8px 28px rgba(0,0,0,.45)');
  /** @type {any[]} */
  let sessions = [];
  let target = null;

  const paintPick = () => {
    const chosen = sessions.find((s) => s.session_id === target);
    const name = chosen ? (chosen.label || chosen.pane_name || chosen.slug || chosen.session_id) : '';
    sep.style.display = pick.style.display = sessions.length ? '' : 'none';
    pick.textContent = name ? `→ ${name} ▾` : '→ choose a session ▾';
    pick.title = chosen ? `this recording goes to ${name}${chosen.cwd ? `  (${chosen.cwd})` : ''}` : '';
  };

  const paintMenu = () => {
    while (menu.firstChild) menu.removeChild(menu.firstChild);
    for (const s of sessions) {
      const name = s.label || s.pane_name || s.slug || s.session_id;
      const row = mk('div',
        'padding:6px 8px;border-radius:5px;cursor:pointer;white-space:nowrap;overflow:hidden;' +
        `text-overflow:ellipsis;color:${s.session_id === target ? '#a5adff' : '#e6edf3'};` +
        `background:${s.session_id === target ? '#161b22' : 'transparent'}`);
      row.textContent = `${s.session_id === target ? '✓ ' : '   '}${name}` +
        (s.agent_status && s.agent_status !== 'idle' ? ` — ${s.agent_status}` : '');
      row.onclick = () => {
        target = s.session_id;
        menu.style.display = 'none';
        paintPick(); paintMenu();
        // Upward. The service worker owns the choice per tab and the host has
        // to know it before the session is finalized, or the artifact has
        // nowhere to go.
        try { document.dispatchEvent(new CustomEvent('__rewalk_target', { detail: s.session_id })); } catch (e) {}
      };
      menu.appendChild(row);
    }
  };

  pick.onclick = (e) => {
    e.preventDefault(); e.stopPropagation();
    menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
  };
  document.addEventListener('__rewalk_sessions', (e) => {
    try {
      const d = JSON.parse(/** @type {any} */ (e).detail);
      sessions = Array.isArray(d.sessions) ? d.sessions : [];
      if (d.target !== undefined) target = d.target;
      paintPick(); paintMenu();
    } catch (x) {}
  });

  // Nothing is on the page until somebody asks. A recording that draws a panel
  // the moment it starts is a recording of a page with our panel on it. Tab is
  // the ask; lib/highlight.js owns the keystroke and lib/frames.js carries it
  // here, because this file is top-frame only and the key may have been pressed
  // inside an iframe.
  let shown = false;
  const attach = () => {
    if (shown || !document.body) return;
    shown = true;
    document.body.appendChild(root);
    document.body.appendChild(toast);
  };
  document.addEventListener('__rewalk_arm', () => {
    if (document.body) attach();
    else addEventListener('DOMContentLoaded', attach, { once: true });
  });

  root.appendChild(dot); root.appendChild(meter); root.appendChild(label);
  root.appendChild(sep); root.appendChild(pick); root.appendChild(menu);
  paintPick();

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
    menu.style.display = 'none';
    clearInterval(statusTimer);
    clearTimeout(toastTimer);
    window.__rewalkHudLevel = () => {};
    try { root.remove(); toast.remove(); } catch (e) {}
  }, { once: true });
})();
