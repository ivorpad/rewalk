// Injected next to rrweb. Adds the three things a raw mutation stream does not
// have, and that the join needs.
//
// 1. Clock. rrweb stamps Date.now(); a transcript returns offsets from the start
//    of the audio stream. A single anchor at t0 drifts, because MediaRecorder
//    does not start when you ask it to. So we emit both clocks together, often,
//    and let the resolver interpolate between drift-corrected points.
// 2. Rects. Two things are invisible in the mutation stream: a CSS transition
//    (one class flip, then 220ms of movement nobody records) and any layout-
//    derived value (a card's rendered height changes because its text changed,
//    and no attribute ever says so). Both are visible in getBoundingClientRect.
// 3. Marks. Alt-click as push-to-talk: the selector travels with the utterance.
(() => {
  if (window.__rewalk || location.href === 'about:blank') return;
  window.__rewalk = 1;

  const TICK_MS = 250;       // rect sampling cadence
  const CLOCK_MS = 2000;     // clock pair cadence
  const WATCH_MS = 800;      // keep sampling a node this long after it mutates,
                             // which is what makes a 220ms transition visible
  const ANCESTORS = 3;       // a text change resizes the box that contains it

  const t0 = performance.now();
  const elapsed = () => Math.round(performance.now() - t0);
  const emit = (type, data) => {
    try { window.rrweb?.record?.addCustomEvent?.(type, data); } catch (e) {}
  };

  // --- selectors -----------------------------------------------------------
  // Same shape tap already uses: an id if it is unique, otherwise a readable
  // path. A selector nobody can read is a selector nobody will trust.
  const sel = (el) => {
    if (!el || el.nodeType !== 1) return null;
    if (el.id) return '#' + CSS.escape(el.id);
    const label = el.getAttribute('aria-label');
    if (label && document.querySelectorAll(`[aria-label="${CSS.escape(label)}"]`).length === 1)
      return `[aria-label="${label}"]`;
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1 && parts.length < 5) {
      let p = n.tagName.toLowerCase();
      if (n.id) { parts.unshift('#' + CSS.escape(n.id)); break; }
      const dl = n.getAttribute('data-line');
      if (dl) p += `[data-line="${dl}"]`;
      else {
        const cls = [...n.classList].filter((c) => c.length < 24 && !/[0-9]{3,}|^css-|^sc-/.test(c)).slice(0, 2);
        if (cls.length) p += cls.map((c) => '.' + CSS.escape(c)).join('');
      }
      parts.unshift(p);
      try { if (document.querySelectorAll(parts.join(' > ')).length === 1) break; } catch (e) {}
      n = n.parentElement;
    }
    return parts.join(' > ');
  };

  // --- what to sample ------------------------------------------------------
  // A node enters the watch set when it mutates, and leaves WATCH_MS later.
  // Ancestors come too, because that is where a layout-derived change lands.
  const watch = new Map();                       // Element -> expiry (elapsed ms)
  const arm = (node) => {
    let el = node.nodeType === 1 ? node : node.parentElement;
    for (let i = 0; el && i <= ANCESTORS; i++, el = el.parentElement) {
      if (el.nodeType === 1 && el !== document.documentElement) watch.set(el, elapsed() + WATCH_MS);
    }
  };

  new MutationObserver((records) => {
    for (const r of records) {
      arm(r.target);
      for (const n of r.addedNodes) if (n.nodeType === 1) arm(n);
    }
  }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });

  // Positioned and labelled elements are sampled always, not just when armed:
  // the whole point is to not need the right hypothesis in advance.
  const standing = () => {
    const out = new Set();
    for (const el of document.querySelectorAll('[aria-label],[role],[data-testid]')) out.add(el);
    for (const el of document.querySelectorAll('*')) {
      if (out.size > 400) break;
      const p = getComputedStyle(el).position;
      if (p === 'absolute' || p === 'fixed' || p === 'sticky') out.add(el);
    }
    return out;
  };
  let standingSet = standing();
  setInterval(() => { standingSet = standing(); }, 4000);

  // --- the tick ------------------------------------------------------------
  const last = new WeakMap();
  const r4 = (r) => [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
  const changed = (a, b) => !a || a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2] || a[3] !== b[3];

  setInterval(() => {
    const now = elapsed();
    const set = new Set(standingSet);
    for (const [el, exp] of watch) (exp < now ? watch.delete(el) : set.add(el));
    const rects = [];
    for (const el of set) {
      if (!el.isConnected) continue;
      const r = r4(el.getBoundingClientRect());
      if (r[2] === 0 && r[3] === 0) continue;
      const prev = last.get(el);
      if (!changed(prev, r)) continue;
      last.set(el, r);
      if (prev) rects.push({ s: sel(el), from: prev, to: r });
    }
    if (rects.length) emit('rewalk-rects', { at: now, rects });
  }, TICK_MS);

  // scrollTop is neither an attribute nor a rect, and it was the whole story
  // in the bug that motivated this tool.
  const scrolls = new WeakMap();
  const scrollables = () => [...document.querySelectorAll('*')].filter((el) => el.scrollHeight > el.clientHeight + 1);
  setInterval(() => {
    for (const el of scrollables()) {
      const v = Math.round(el.scrollTop);
      const prev = scrolls.get(el);
      if (prev === v) continue;
      scrolls.set(el, v);
      if (prev !== undefined) emit('rewalk-scroll', { at: elapsed(), s: sel(el), from: prev, to: v });
    }
  }, TICK_MS);

  // A property that never changes cannot appear in a stream of changes, and
  // "it never scrolled" is exactly the complaint we have to be able to answer.
  // So publish what is *observable* on a slow heartbeat, separately from what
  // moved. This is what gives the stasis query something to range over.
  const observe = () => emit('rewalk-observe', {
    at: elapsed(),
    scrollables: scrollables().map((el) => ({ s: sel(el), prop: 'scrollTop', v: Math.round(el.scrollTop) })),
    boxes: [...standingSet].filter((el) => el.isConnected).slice(0, 120).map((el) => {
      const r = el.getBoundingClientRect();
      return { s: sel(el), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    }),
  });
  setInterval(observe, 4000);
  setTimeout(observe, 300);

  setInterval(() => emit('rewalk-clock', { recorderElapsedMs: elapsed(), wall: Date.now() }), CLOCK_MS);
  emit('rewalk-clock', { recorderElapsedMs: elapsed(), wall: Date.now() });

  // --- marks ---------------------------------------------------------------
  window.__rewalkMark = (kind, payload) => emit('rewalk-mark', { at: elapsed(), kind, ...payload });
  addEventListener('click', (e) => {
    const el = e.target?.closest?.('button,a,[role=button],[role=tab],input,select,textarea,[data-line]') || e.target;
    const held = e.altKey;
    const chain = [];
    for (let n = el; n && n.nodeType === 1 && chain.length < 8; n = n.parentElement) chain.push(sel(n));
    setTimeout(() => window.__rewalkMark(held ? 'point' : 'click', {
      s: sel(el), chain, text: (el.textContent || '').trim().slice(0, 60),
    }), 0);
  }, true);
})();
