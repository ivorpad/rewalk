// Motion, as a first-class signal.
//
// The original design treated CSS transitions as a blind spot to work around.
// That was wrong, and measurement on a live page settled it: transitions
// announce themselves (transitionrun/start/end/cancel, each carrying
// propertyName and elapsedTime) and document.getAnimations() hands back live
// CSSTransition objects with currentTime and playState. So motion is not a gap
// in the recording -- it is data we were not collecting.
//
// What comes out of here are the numbers that turn subjective complaints into
// assertions:
//   settleMs   interaction -> the last frame on which anything actually MOVED.
//              Deliberately geometric: an opacity fade animates but displaces
//              nothing, and counting it makes "has it settled?" unanswerable on
//              any page with decoration. Fades are covered by transition.* and
//              by the cancel count instead.
//   cancels    transitions interrupted mid-flight; non-zero is visual stutter
//   path       sum of |dposition| over rAF samples
//   net        |end - start|
// path >> net is the signature of "it wanders about" -- 400px travelled to end
// up 100px away. A complaint that used to be a matter of taste becomes a ratio.
(() => {
  if (window.__rewalkMotion || location.href === 'about:blank') return;
  window.__rewalkMotion = 1;

  // Tail after a trigger. Short on purpose: while anything is actually
  // animating the loop extends itself frame by frame (see `until` below), so a
  // long tail buys nothing and stops the window from ever closing between
  // interactions -- which is exactly how the first version emitted no windows
  // at all under a 1.4s step cadence.
  const HOT_MS = 700;
  const END_MS = 200;        // a transition ending is a reason to stop, not to wait
  const t0 = performance.now();
  const elapsed = () => Math.round(performance.now() - t0);
  const emit = (type, data) => {
    try { window.rrweb?.record?.addCustomEvent?.(type, data); } catch (e) {}
  };
  const sel = (el) => {
    if (!el || el.nodeType !== 1) return null;
    if (el.id) return '#' + CSS.escape(el.id);
    const l = el.getAttribute('aria-label');
    if (l) return `[aria-label="${l}"]`;
    const c = [...el.classList].slice(0, 2).map((x) => '.' + x).join('');
    return el.tagName.toLowerCase() + c;
  };

  // --- 1. transition lifecycle --------------------------------------------
  // transitioncancel is the one that matters: a transition created and killed
  // mid-flight on every step is exactly what reads as "lingering" or "smearing".
  const counts = { run: 0, start: 0, end: 0, cancel: 0 };
  for (const [ev, key] of [['transitionrun', 'run'], ['transitionstart', 'start'],
                           ['transitionend', 'end'], ['transitioncancel', 'cancel']]) {
    addEventListener(ev, (e) => {
      counts[key]++;
      emit('rewalk-motion', {
        at: elapsed(), phase: key, s: sel(e.target),
        prop: e.propertyName, elapsedTime: Math.round((e.elapsedTime ?? 0) * 1000),
      });
      hot(key === 'end' ? END_MS : HOT_MS);
    }, true);
  }

  // --- 2. rAF sampling while anything is in motion -------------------------
  let until = 0, running = false;
  const hot = (ms) => { until = Math.max(until, elapsed() + ms); if (!running) loop(); };

  // Layout coordinates, not viewport coordinates. getBoundingClientRect is
  // relative to the viewport, so scrolling a container makes every descendant
  // look like it moved several thousand pixels -- which is how a page scroll
  // was being counted as motion, and why settle time and path length flipped
  // between runs depending on rAF scheduling. Accumulating offsetLeft/offsetTop
  // up the offsetParent chain is immune to scrolling.
  // Known limit: position:fixed elements are correctly viewport-relative, and
  // this will under-report their movement when the page scrolls beneath them.
  const r4 = (el) => {
    const r = el.getBoundingClientRect();
    let x = 0, y = 0;
    for (let n = el; n; n = n.offsetParent) { x += n.offsetLeft || 0; y += n.offsetTop || 0; }
    return [x, y, r.width, r.height];
  };

  function loop() {
    running = true;
    const tracks = new Map();      // selector -> {first, last, path, frames}
    const startedAt = elapsed();
    let frames = 0, inMotion = 0, lastMotionAt = startedAt;
    const props = new Set();

    const step = () => {
      const now = elapsed();
      frames++;
      let anims = [];
      try { anims = document.getAnimations(); } catch (e) {}
      const live = anims.filter((a) => a.playState === 'running');
      if (live.length) { inMotion++; until = Math.max(until, now + 200); }

      const targets = new Set();
      for (const a of live) {
        const el = a.effect?.target;
        if (el) targets.add(el);
        const p = a.transitionProperty ?? a.animationName;
        if (p) props.add(String(p));
      }
      // Sample geometry of anything animating, plus anything already tracked,
      // so the path is continuous rather than only covering the animated frames.
      for (const el of targets) {
        const s = sel(el);
        if (!s) continue;
        const r = r4(el);
        const t = tracks.get(s);
        if (!t) { tracks.set(s, { first: r, last: r, path: 0, frames: 1, lastAt: now }); continue; }
        // Re-baseline across a gap: start a fresh segment. `first` has to move
        // too, or net displacement still spans the gap that path just ignored,
        // and the two numbers describe different journeys.
        // Sampling only runs while something animates, so consecutive samples
        // can straddle a long gap. Layout coordinates make that harmless, but
        // re-baseline anyway rather than trust a diff across dead time.
        if (now - t.lastAt > 200) { t.first = r; t.last = r; t.lastAt = now; continue; }
        const moved = Math.hypot(r[0] - t.last[0], r[1] - t.last[1]);
        if (moved > 0.5 || r[2] !== t.last[2] || r[3] !== t.last[3]) lastMotionAt = now;
        t.path += moved;
        t.last = r; t.lastAt = now; t.frames++;
      }

      if (now < until) return requestAnimationFrame(step);

      running = false;
      const out = [];
      for (const [s, t] of tracks) {
        const net = Math.hypot(t.last[0] - t.first[0], t.last[1] - t.first[1]);
        out.push({
          s, frames: t.frames,
          path: Math.round(t.path), net: Math.round(net),
          // path/net, with net floored at 1px: returning to where you started
          // after travelling 300px is maximal waste, not an undefined ratio.
          wander: t.path <= 1 ? 1 : +Math.min(99, t.path / Math.max(net, 1)).toFixed(2),
          from: t.first.map(Math.round), to: t.last.map(Math.round),
        });
      }
      emit('rewalk-motion-window', {
        at: startedAt, settleMs: lastMotionAt - startedAt, sampledMs: now - startedAt,
        frames, framesInMotion: inMotion,
        props: [...props], cancels: counts.cancel, runs: counts.run,
        tracks: out,
      });
      Object.keys(counts).forEach((k) => (counts[k] = 0));
    };
    requestAnimationFrame(step);
  }

  // An interaction is a trigger too: layout-derived changes (a card that grows
  // because its text got longer) never fire a transition event, and sampling on
  // rAF during the window after a click is what makes them visible.
  addEventListener('click', () => hot(HOT_MS), true);
  addEventListener('keydown', () => hot(HOT_MS), true);
  window.__rewalkHot = hot;
})();
