// The pointing lens. Injected only when a human is being recorded, same gate
// as the HUD: as the pointer moves, a hairline ring sits on the element a
// click would mark, with a small chip naming it. Holding ⌥ turns the ring
// amber (a point is armed); a ⌥-click flashes green. Typing hides the ring
// until the pointer moves again.
//
// Same non-negotiables as the HUD, for the same reasons:
// - rr-block + an excluded id keep it out of rrweb, tick.js and deltas.mjs.
// - NO css transitions or animations. Every frame is an inline style write
//   from a rAF loop, so motion.js (transition events + getAnimations) can
//   never discover the instrument.
// - The target is chosen with the SAME closest() list the mark handler in
//   tick.js uses, and the chip names the SAME fiber walk the mark records
//   (window.__rewalkReact) — what the ring shows is what lands in the session.
(() => {
  if (window.__rewalkHl || location.href === 'about:blank') return;
  window.__rewalkHl = 1;

  // byte-for-byte the closest() list in tick.js's mark handler
  const INTERACTIVE = 'button,a,[role=button],[role=tab],input,select,textarea,[data-line]';
  // The annotate overlay joins this list: while someone is picking elements to
  // comment on, the lens must not ring the panel they are typing into.
  const HUD = '#rewalk-hud,#rewalk-hud-toast,#rewalk-hud-hl,#rewalk-comment';
  const INDIGO = '124,134,255', AMBER = '210,153,34', GREEN = '63,185,80';

  const mk = (css) => { const el = document.createElement('div'); el.style.cssText = css; return el; };
  const root = mk('position:fixed;left:0;top:0;width:0;height:0;z-index:2147483646;pointer-events:none');
  root.id = 'rewalk-hud-hl';
  root.className = 'rr-block';
  const ring = mk('position:fixed;left:0;top:0;width:0;height:0;opacity:0;box-sizing:border-box;will-change:transform');
  const chip = mk('position:fixed;left:0;top:0;opacity:0;font:11px/1.2 ui-sans-serif,system-ui,sans-serif;' +
    'color:#e6edf3;background:rgba(14,17,22,.94);border:1px solid #2a323d;border-radius:6px;' +
    'padding:4px 7px;white-space:nowrap;max-width:380px;overflow:hidden;text-overflow:ellipsis;will-change:transform');
  const chipName = document.createElement('b');
  chipName.style.cssText = 'font-weight:600;color:#a5adff';
  const chipSel = document.createElement('span');
  chipSel.style.cssText = 'color:#8b949e';
  chip.appendChild(chipName); chip.appendChild(chipSel);
  root.appendChild(ring); root.appendChild(chip);
  const attach = () => document.body.appendChild(root);
  document.body ? attach() : addEventListener('DOMContentLoaded', attach);

  let dead = false;                        // set on __rewalk_stop; every handler goes inert
  // While the comment overlay is picking elements it draws its own hover box
  // and its own green rings. Two lenses chasing the same pointer is noise, and
  // the person is not pointing for the recording just then — they are choosing
  // what to write about. Same DOM channel tick.js listens on.
  document.addEventListener('__rewalk_annotate', (e) => {
    const annotating = e.detail === 'on';
    target = annotating ? null : target;
    root.style.display = annotating ? 'none' : '';
  });
  let target = null;
  let mode = INDIGO;                       // AMBER while ⌥ is held
  let flashColor = null, flashUntil = 0;   // brief color override after a click
  let radius = 8;
  const cur = { x: 0, y: 0, w: 0, h: 0, o: 0 };
  let painted = '';

  const paint = (color) => {
    if (painted === color) return;
    painted = color;
    ring.style.border = `1.5px solid rgba(${color},.9)`;
  };

  const describe = (el) => {
    let name = '';
    try { name = window.__rewalkReact?.(el)?.chain?.[0] ?? ''; } catch (e) {}
    const label = el.getAttribute?.('aria-label') ||
      (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 32) || '';
    chipName.textContent = name;
    chipSel.textContent = (name ? ' — ' : '') + `<${el.tagName.toLowerCase()}>` + (label ? ` “${label}”` : '');
  };

  let raf = 0;
  const wake = () => { if (!dead && !raf) raf = requestAnimationFrame(frame); };

  const frame = () => {
    raf = 0;
    const now = performance.now();
    let settled = true;

    // where the ring wants to be: the live rect, re-read so scroll cannot lie
    let tx = cur.x, ty = cur.y, tw = cur.w, th = cur.h, to = 0;
    if (target && target.isConnected) {
      const r = target.getBoundingClientRect();
      if (r.width || r.height) { tx = r.left - 2; ty = r.top - 2; tw = r.width + 4; th = r.height + 4; to = 1; }
    }
    const k = 0.3;
    cur.x += (tx - cur.x) * k; cur.y += (ty - cur.y) * k;
    cur.w += (tw - cur.w) * k; cur.h += (th - cur.h) * k;
    cur.o += (to - cur.o) * 0.25;
    if (Math.abs(tx - cur.x) + Math.abs(ty - cur.y) + Math.abs(tw - cur.w) + Math.abs(th - cur.h) > 0.5 ||
        Math.abs(to - cur.o) > 0.02) settled = false;
    else { cur.x = tx; cur.y = ty; cur.w = tw; cur.h = th; cur.o = to; }

    ring.style.transform = `translate(${cur.x}px,${cur.y}px)`;
    ring.style.width = cur.w + 'px';
    ring.style.height = cur.h + 'px';
    ring.style.borderRadius = radius + 'px';
    ring.style.opacity = String(cur.o);

    if (flashColor && now < flashUntil) { paint(flashColor); settled = false; }
    else { flashColor = null; paint(mode); }

    // chip rides the ring: above it, or below when the top is off screen
    if (cur.o > 0.05) {
      const above = cur.y - chip.offsetHeight - 7;
      chip.style.transform = `translate(${Math.max(6, Math.min(cur.x, innerWidth - chip.offsetWidth - 6))}px,${above > 4 ? above : cur.y + cur.h + 7}px)`;
    }
    chip.style.opacity = String(cur.o * 0.97);

    if (!settled) wake();
  };

  const retarget = (el) => {
    if (el === target) return;
    target = el;
    if (el) {
      const br = parseFloat(getComputedStyle(el).borderTopLeftRadius);
      radius = (Number.isFinite(br) && br > 0 ? Math.min(br, 24) : 5) + 2;
      describe(el);
    }
    wake();
  };

  addEventListener('pointermove', (e) => {
    if (dead) return;
    mode = e.altKey ? AMBER : INDIGO;
    const t = e.target && e.target.nodeType === 1 ? e.target : null;
    if (!t || t.closest(HUD)) return;
    if (t === document.documentElement || t === document.body) { retarget(null); return; }
    retarget(t.closest(INTERACTIVE) || t);
    wake();
  }, { capture: true, passive: true });

  addEventListener('pointerleave', (e) => { if (e.target === document.documentElement) retarget(null); }, true);
  // ⌥ arms a point; any other key means the hands are on the keyboard now —
  // hide the ring until the pointer moves again.
  addEventListener('keydown', (e) => {
    if (e.key === 'Alt') { mode = AMBER; wake(); return; }
    retarget(null);
  }, true);
  addEventListener('keyup', (e) => { if (e.key === 'Alt') { mode = INDIGO; wake(); } }, true);
  addEventListener('scroll', wake, { capture: true, passive: true });

  // Same capture phase and same closest() as the mark handler in tick.js:
  // the flash confirms exactly what the mark records, or it confirms nothing.
  addEventListener('click', (e) => {
    if (dead) return;
    const t = e.target && e.target.nodeType === 1 ? e.target : null;
    if (!t || t.closest(HUD)) return;
    retarget(t.closest(INTERACTIVE) || t);
    flashColor = e.altKey ? GREEN : INDIGO;
    flashUntil = performance.now() + 240;
    wake();
  }, true);

  // Recording stopped: the lens leaves with it, immediately.
  document.addEventListener('__rewalk_stop', () => {
    dead = true;
    target = null;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    try { root.remove(); } catch (e) {}
  }, { once: true });
})();
