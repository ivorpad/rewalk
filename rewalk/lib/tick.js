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
  // lib/selector.js, concatenated ahead of this file by bootScript(). It is a
  // separate file because the comment overlay runs in the ISOLATED world and
  // must name elements exactly the way marks here do — a comment pointing at a
  // different node than the mark for the same click is a bug nobody would see
  // until an agent edited the wrong component.
  const sel = window.__rewalkSelector;

  // --- what to sample ------------------------------------------------------
  // A node enters the watch set when it mutates, and leaves WATCH_MS later.
  // Ancestors come too, because that is where a layout-derived change lands.
  const watch = new Map();                       // Element -> expiry (elapsed ms)
  // The recording HUD (lib/hud.js) animates a level meter twice a second. Left
  // in the watch set it would be the most frequently changing element on any
  // page -- the instrument outscoring what it measures, same trap as the
  // teleprompter. The lens and the comment panel are excluded for the same
  // reason: they draw over whatever the person is complaining about, which is
  // by construction the most interesting-looking churn on the page.
  //
  // One list, in lib/lens.js, read by every instrument. It used to be spelled
  // out separately here, in deltas.mjs and in highlight.js, which is three
  // places to forget when an id changes.
  const isHud = (el) => window.__rewalkLens.isOurs(el);
  const arm = (node) => {
    let el = node.nodeType === 1 ? node : node.parentElement;
    if (isHud(el)) return;
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
    for (const el of document.querySelectorAll('[aria-label],[role],[data-testid]')) { if (!isHud(el)) out.add(el); }
    for (const el of document.querySelectorAll('*')) {
      if (out.size > 400) break;
      if (isHud(el)) continue;
      const p = getComputedStyle(el).position;
      if (p === 'absolute' || p === 'fixed' || p === 'sticky') out.add(el);
    }
    return out;
  };
  let standingSet = standing();
  setInterval(() => { standingSet = standing(); }, 4000);

  // --- the tick ------------------------------------------------------------
  // Rects are sampled in LAYOUT coordinates (offsetLeft/offsetTop accumulated
  // up the offsetParent chain), not getBoundingClientRect's viewport frame.
  // Same reasoning that already moved motion.js off the viewport frame, now
  // paid for a second time on a real app: ledger's transaction page scrolls,
  // and one scroll made every watched element emit rect.y deltas of hundreds
  // of pixels -- 4.298 "[aria-label=Close] rect.y -283 -> -717" outranked real
  // findings in three separate utterances. Scrolling is already its own
  // first-class stream (rewalk-scroll); "did this element move?" must not be
  // answerable by scrolling past it.
  // Known limit, same as motion.js: position:fixed elements are genuinely
  // viewport-relative and under-report when the page scrolls beneath them.
  const last = new WeakMap();
  const r4 = (el) => {
    const r = el.getBoundingClientRect();
    let x = 0, y = 0;
    for (let n = el; n; n = n.offsetParent) { x += n.offsetLeft || 0; y += n.offsetTop || 0; }
    return [Math.round(x), Math.round(y), Math.round(r.width), Math.round(r.height)];
  };
  const changed = (a, b) => !a || a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2] || a[3] !== b[3];

  setInterval(() => {
    const now = elapsed();
    const set = new Set(standingSet);
    for (const [el, exp] of watch) (exp < now ? watch.delete(el) : set.add(el));
    const rects = [];
    for (const el of set) {
      if (!el.isConnected) continue;
      const r = r4(el);
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

  // --- components ------------------------------------------------------------
  // The fiber walk moved to lib/react.js, concatenated ahead of this file. The
  // lens needs it inside iframes, where tick.js never runs, and the comment
  // overlay needs it from the ISOLATED world; keeping it here meant only the
  // top frame of a recording could name a component.
  const react = window.__rewalkReact;

  // --- marks ---------------------------------------------------------------
  // While the comment overlay is open, a click is the person choosing which
  // element to talk about — the app never receives it, and recording it as an
  // interaction would put marks in the session for clicks that never happened.
  // The overlay runs in the ISOLATED world and says so over the DOM, the only
  // channel the two worlds share. It cannot do this by stopping the event:
  // this listener is registered at document_start and runs first.
  let annotating = false;
  document.addEventListener('__rewalk_annotate', (e) => { annotating = e.detail === 'on'; });

  window.__rewalkMark = (kind, payload) => emit('rewalk-mark', { at: elapsed(), kind, ...payload });
  addEventListener('click', (e) => {
    if (annotating) return;
    // lens.pickTarget is the same choice the ring the person just saw made.
    // It returns null for <body>/<html>, where the old inline closest() fell
    // through to the event target — keep that, a click on the page background
    // is still a mark.
    const el = window.__rewalkLens.pickTarget(e.target) || e.target;
    const held = e.altKey;
    const chain = [];
    for (let n = el; n && n.nodeType === 1 && chain.length < 8; n = n.parentElement) chain.push(sel(n));
    // Walk the fiber NOW, not in the timeout: the click's own handler may
    // unmount this subtree before the task queue drains.
    const fc = react(e.target);
    setTimeout(() => window.__rewalkMark(held ? 'point' : 'click', {
      s: sel(el), chain, text: (el.textContent || '').trim().slice(0, 60),
      ...(fc ? { react: fc } : {}),
    }), 0);
  }, true);
})();
