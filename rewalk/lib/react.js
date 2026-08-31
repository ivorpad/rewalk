// Which component the person is touching, read live from the fiber under the
// pointer.
//
// This was inside tick.js, which only ever runs in the top frame of a recording.
// Three other places need the same answer: the lens labelling what it rings
// (including inside an iframe, where tick.js is not), the mark that gets
// recorded, and the comment overlay in the ISOLATED world, which cannot reach
// a MAIN-world function at all and used to ship `react: null` while the ring
// beside it was naming the component. One file, evaluated per world and per
// frame, is the same arrangement lib/selector.js and lib/lens.js have.
//
// The state the recorder saw only exists at click time: recovering it
// afterwards meant replaying a whole session against a running dev app and
// throttling the network to catch suspense states (probes/fiber-enrich.mjs).
// A2 killed component names as a *ranking* signal — locate stays pristine — so
// this travels with the mark as description, never as a score.
//
// Production builds minify function names to 1-2 chars; keep what looks
// authored (uppercase start, 3+ chars, measured DENY list from the A2 probe)
// plus React dev _debugInfo (server-component names). Unnamed composites are
// counted rather than dropped: `anon` is what tells a minified React app apart
// from a page with no React at all. Prop KEYS only — values follow the
// maskAllInputs rule and never enter the stream.
(() => {
  if (window.__rewalkReact || location.href === 'about:blank') return;

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

  window.__rewalkReact = react;

  // The comment overlay needs the same walk and cannot have it: it runs in the
  // ISOLATED world, where this function does not exist. So answer for it over
  // the DOM, the only channel the two worlds share. The question arrives ON the
  // element (e.target is the node being asked about) carrying a token, and the
  // answer goes back as a JSON string, because structured-clone of cross-world
  // objects is fragile and a string is not. Both dispatches are synchronous, so
  // the asker has its answer before its own dispatchEvent returns.
  //
  // A custom event type nobody listens for leaves no trace in the recording, and
  // no page node is mutated to carry the question.
  document.addEventListener('__rewalk_react_q', (e) => {
    let chain = null;
    try { chain = react(e.target); } catch (x) {}
    try {
      document.dispatchEvent(new CustomEvent('__rewalk_react_a',
        { detail: JSON.stringify({ token: e.detail, react: chain }) }));
    } catch (x) {}
  }, true);
})();
