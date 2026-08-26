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
  // el.id is NOT safe on a form: named controls shadow the property, so a
  // <form> containing <input name="id"> returns that INPUT ELEMENT from
  // form.id, and CSS.escape stringifies it to "[object HTMLInputElement]".
  // Measured on a real app (ledger): five unrelated forms each carried a
  // hidden id field, every one collapsed to the identical bogus selector, and
  // the ranking merged five distinct nodes into one. getAttribute cannot be
  // shadowed. The same trap exists for name, action, and anything else a
  // control can be named after.
  const idOf = (el) => {
    const v = el.getAttribute && el.getAttribute('id');
    return typeof v === 'string' && v ? v : null;
  };
  const sel = (el) => {
    if (!el || el.nodeType !== 1) return null;
    if (idOf(el)) return '#' + CSS.escape(idOf(el));
    const label = el.getAttribute('aria-label');
    if (label && document.querySelectorAll(`[aria-label="${CSS.escape(label)}"]`).length === 1)
      return `[aria-label="${label}"]`;
    const testid = el.getAttribute('data-testid');
    if (testid && document.querySelectorAll(`[data-testid="${CSS.escape(testid)}"]`).length === 1)
      return `[data-testid="${testid}"]`;
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1 && parts.length < 5) {
      let p = n.tagName.toLowerCase();
      if (idOf(n)) { parts.unshift('#' + CSS.escape(idOf(n))); break; }
      const alabel = n.getAttribute('aria-label');
      if (alabel && document.querySelectorAll(`[aria-label="${CSS.escape(alabel)}"]`).length === 1) {
        parts.unshift(`[aria-label="${alabel}"]`); break;
      }
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
  // The recording HUD (lib/hud.js) animates a level meter twice a second. Left
  // in the watch set it would be the most frequently changing element on any
  // page -- the instrument outscoring what it measures, same trap as the
  // teleprompter.
  const isHud = (el) => !!(el && el.closest && el.closest('#rewalk-hud,#rewalk-hud-toast,#rewalk-hud-hl'));
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
  // Which component the person is touching, read live from the fiber under the
  // click. The state the recorder saw only exists at click time: recovering it
  // afterwards meant replaying a whole session against a running dev app and
  // throttling the network to catch suspense states (probes/fiber-enrich.mjs).
  // A2 killed component names as a *ranking* signal — locate stays pristine —
  // so this travels with the mark as description, never as a score.
  // Production builds minify function names to 1-2 chars; keep what looks
  // authored (uppercase start, 3+ chars, measured DENY list from the A2 probe)
  // plus React dev _debugInfo (server-component names). Unnamed composites are
  // counted rather than dropped: `anon` is what tells a minified React app
  // apart from a page with no React at all. Prop KEYS only — values follow the
  // maskAllInputs rule and never enter the stream.
  // The A2 probe's list, extended from live runs: Next 16 renamed its scroll
  // handlers and grew ErrorBoundaryHandler/ServerRoot/Root (ledger fixture);
  // react-router's Route was the only "name" on every click in a real Linear
  // recording and says nothing about the component clicked.
  const FIBER_DENY = /^__next|Boundary$|Context$|Provider$|^(LinkComponent|InnerLayoutRouter|OuterLayoutRouter|SegmentViewNode|RenderFromTemplateContext|ScrollAndFocusHandler|ScrollAndMaybeFocusHandler|InnerScrollHandlerNew|ErrorBoundaryHandler|HotReload|Router|AppRouter|ServerRoot|Root|Route|Routes|Outlet|Head)$/;
  // 4+ chars, measured twice: the A2 probe chose it on ledger, and the first
  // production recording (Linear) minted a 3-char capitalised minified name
  // ("Xon") that a 3-char floor recorded as if authored.
  const AUTHORED = /^[A-Z][A-Za-z0-9_$]{3,}$/;
  const react = (target) => {
    try {
      let host = target && target.nodeType === 1 ? target : target && target.parentElement;
      let key = null;
      for (let i = 0; host && i < 4 && !(key = Object.keys(host).find((k) => k.startsWith('__reactFiber$'))); i++)
        host = host.parentElement;
      if (!key) return null;
      const chain = []; let anon = 0, props = null;
      let f = host[key], hops = 0;
      while (f && hops < 60 && chain.length < 8) {
        const t = f.type;
        const own = typeof t === 'function' ? (t.displayName || t.name)
          : t && typeof t === 'object' ? (t.displayName || t.render?.displayName || t.render?.name || t.type?.displayName || t.type?.name)
          : null;
        const names = (f._debugInfo ?? []).map((d) => d.name).filter(Boolean);
        if (own) names.push(own);
        let kept = false;
        for (const n of names) {
          if (!AUTHORED.test(n) || FIBER_DENY.test(n) || chain.includes(n)) continue;
          chain.push(n); kept = true;
          // props belong to the innermost named CLIENT component; a _debugInfo
          // name is a server component whose props never reached this fiber.
          // Measured on ledger: without the n === own guard the keys were the
          // router's own (focusAndScrollRef, cacheNode), not a contract.
          if (!props && n === own && f.memoizedProps && typeof f.memoizedProps === 'object' && !Array.isArray(f.memoizedProps)) {
            const ks = Object.keys(f.memoizedProps).filter((k) => k !== 'children').slice(0, 12);
            if (ks.length) props = ks;
          }
        }
        // Context objects render nothing of their own — don't count them as
        // anonymous components (_currentValue marks a context, _context a consumer).
        const contextish = t && typeof t === 'object' && ('_currentValue' in t || t._context);
        if (!kept && !contextish && (typeof t === 'function' || (t && typeof t === 'object' && !own))) anon++;
        f = f.return; hops++;
      }
      if (!chain.length && !anon) return null;
      return { chain, ...(anon ? { anon } : {}), ...(props ? { props } : {}) };
    } catch (e) { return null; }
  };
  // The highlight lens (highlight.js) labels what it rings with the same walk,
  // so the ring and the mark can never disagree about the component.
  window.__rewalkReact = react;

  // --- marks ---------------------------------------------------------------
  window.__rewalkMark = (kind, payload) => emit('rewalk-mark', { at: elapsed(), kind, ...payload });
  addEventListener('click', (e) => {
    const el = e.target?.closest?.('button,a,[role=button],[role=tab],input,select,textarea,[data-line]') || e.target;
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
