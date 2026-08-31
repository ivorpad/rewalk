// The pointing lens, as a driver over lib/lens.js.
//
// This file used to own an overlay of its own — host element, ring, chip, rAF
// loop, and a position:fixed assumption that was wrong on any page with a
// transform on <html>. All of that moved to lens.js, which the comment overlay
// now draws with too. What is left here is the part that is actually about
// recording: what the pointer is over, whether ⌥ has armed a point, and getting
// out of the way while someone is writing a comment instead.
//
// Nothing here draws until somebody asks — Tab, or holding ⌥, anywhere in the
// tab (see lib/frames.js). A recording that puts a ring on screen the moment it
// starts was never asked for; a ⌥ that draws nothing is the opposite mistake.
//
// Runs in every frame. In the top frame tick.js records the mark for a click
// and this only draws; in a child frame there is no tick.js and no rrweb to
// emit through, so the mark is sent up through lib/frames.js instead. Marking
// in both places would double every mark in the top frame, so the split is
// exactly `isTop`.
//
// The target is chosen with lens.pickTarget — the same closest() list the mark
// handler in tick.js uses — and the chip names the same fiber walk the mark
// records (lib/react.js). What the ring shows is what lands in the session, or
// it is worth nothing.
(() => {
  if (window.__rewalkHl || location.href === 'about:blank') return;

  const L = window.__rewalkLens;
  const F = window.__rewalkFrames;
  if (!L || !F) return;                    // both concatenated ahead of this
  const lens = L.create({ id: 'rewalk-lens' });
  // Doubles as the once-only guard. The instance is otherwise unreachable —
  // the shadow root is closed — and lens.probe() is the only way to ask from a
  // console where the ring thinks it is.
  window.__rewalkHl = lens;

  let dead = false;                        // set on __rewalk_stop; every handler goes inert
  let up = false;                          // the host element, created on first use only

  // A child frame has to ask whether anything is being recorded, and the answer
  // arrives a tick later. Asking on every pointer move instead of caching it
  // would be a postMessage per frame of mouse movement.
  F.onRecording(() => {});

  const describe = (el) => {
    let name = '';
    try { name = window.__rewalkReact?.(el)?.chain?.[0] ?? ''; } catch (e) {}
    const label = el.getAttribute?.('aria-label') ||
      (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 32) || '';
    lens.label(name, `<${el.tagName.toLowerCase()}>` + (label ? ` “${label}”` : ''));
  };

  const retarget = (el) => {
    if (el === lens.target()) return;
    lens.track(el);
    if (el) describe(el);
  };

  // While the comment overlay is picking elements it draws its own rings from
  // the same lens. Two rings chasing the same pointer is noise, and the person
  // is not pointing for the recording just then — they are choosing what to
  // write about. Same DOM channel tick.js listens on.
  document.addEventListener('__rewalk_annotate', (e) => {
    lens.setHidden(e.detail === 'on');
  });

  /**
   * Nothing is drawn on a page nobody is recording — and until then this file
   * puts NOTHING in the document. The bundle carrying it is also injected when
   * someone opens the comment overlay (for the fiber walk, which only exists in
   * this world), and creating a recording overlay's host on a page where nobody
   * asked to record is how an overlay ends up appearing unbidden.
   */
  const live = () => {
    if (dead || !F.isRecording() || !F.isArmed()) return false;
    if (!up) { lens.ensure(); up = true; }
    return true;
  };

  // Where the pointer is, tracked whether or not anything is drawn.
  //
  // Arming has to be able to ring what is ALREADY under the cursor. Holding ⌥
  // over a button produces no pointermove — the mouse has not gone anywhere —
  // so a lens that only learns its target from movement comes up empty at
  // exactly the moment somebody asked for it, and ⌥ reads as broken.
  let lastX = -1, lastY = -1;

  const armHere = () => {
    if (dead || !F.isRecording()) return;
    if (!up) { lens.ensure(); up = true; }
    if (lastX < 0) return;
    const t = document.elementFromPoint(lastX, lastY);
    if (t && t.nodeType === 1 && !L.isOurs(t)) retarget(L.pickTarget(t));
  };
  document.addEventListener('__rewalk_arm', armHere);

  addEventListener('pointermove', (e) => {
    lastX = e.clientX; lastY = e.clientY;
    if (!live()) return;
    lens.setMode(e.altKey ? L.AMBER : L.INDIGO);
    const t = e.target && e.target.nodeType === 1 ? e.target : null;
    if (!t || L.isOurs(t)) return;
    retarget(L.pickTarget(t));
  }, { capture: true, passive: true });

  addEventListener('pointerleave', (e) => { if (e.target === document.documentElement) retarget(null); }, true);
  // ⌥ arms a point; any other key means the hands are on the keyboard now —
  // hide the ring until the pointer moves again.
  addEventListener('keydown', (e) => {
    if (dead || !F.isRecording()) return;
    // Tab asks for the instruments. Until it is pressed a recording puts
    // NOTHING on the page — no HUD, no ring — because the person asked to
    // record their app, not a page with our panel on it.
    //
    // Deliberately NOT swallowed. Tab is how somebody moves through the app
    // being recorded, and a session in which focus never moves is a recording
    // of a different program. preventDefault() here would also drop the
    // keystroke that produced the focus change out of the stream the resolver
    // has to explain. So arming is a side effect of a real Tab, not instead
    // of one.
    // Tab AND ⌥ both ask. ⌥ is the pointing modifier — holding it is the most
    // direct way there is of saying "show me what I am about to point at" —
    // and making it do nothing until some other key had been pressed first
    // meant the one gesture this product is built around read as broken.
    // F.arm() dispatches synchronously, so live() below is already true and
    // the ring lands on whatever is under the cursor in this same keystroke.
    if (e.key === 'Tab' || e.key === 'Alt') F.arm();
    if (!live()) return;
    if (e.key === 'Alt') { lens.setMode(L.AMBER); return; }
    if (e.key === 'Tab') return;
    retarget(null);
  }, true);
  addEventListener('keyup', (e) => { if (live() && e.key === 'Alt') lens.setMode(L.INDIGO); }, true);
  addEventListener('scroll', lens.wake, { capture: true, passive: true });

  // Same capture phase and same target choice as the mark handler in tick.js:
  // the flash confirms exactly what the mark records, or it confirms nothing.
  addEventListener('click', (e) => {
    if (dead || !F.isRecording()) return;
    const t = e.target && e.target.nodeType === 1 ? e.target : null;
    if (!t || L.isOurs(t)) return;
    const el = L.pickTarget(t) || t;
    // DRAWING waits for Tab. RECORDING does not, and the two had to be pulled
    // apart here: in the top frame tick.js records the mark regardless, so
    // gating this whole handler on arming meant a ⌥-click before Tab was
    // recorded in the top frame and silently dropped inside an iframe — where
    // this is the only thing that can record one. A point made before anybody
    // asked for the instruments is still a point; it just does not flash.
    if (live()) {
      retarget(el);
      lens.flash(e.altKey ? L.GREEN : L.INDIGO);
    }

    // In the top frame tick.js already recorded this click. Down here nothing
    // did, and nothing could: the event never reaches the frame that owns the
    // recorder. Build the same payload tick.js builds and send it up.
    if (!F.isTop) {
      const sel = window.__rewalkSelector;
      const chain = [];
      for (let n = el; n && n.nodeType === 1 && chain.length < 8; n = n.parentElement) chain.push(sel(n));
      // Walk the fiber NOW, not after the hop: the click's own handler may
      // unmount this subtree before the message is delivered.
      let fc = null;
      try { fc = window.__rewalkReact?.(t) ?? null; } catch (x) {}
      F.sendMark(e.altKey ? 'point' : 'click', {
        s: sel(el), chain, text: (el.textContent || '').trim().slice(0, 60),
        ...(fc ? { react: fc } : {}),
      });
    }
  }, true);

  // Recording stopped: the lens leaves with it, immediately.
  document.addEventListener('__rewalk_stop', () => {
    dead = true;
    lens.teardown();
  }, { once: true });
})();
