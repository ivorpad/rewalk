// What a child frame can and cannot do, and how it asks the top frame for the
// rest.
//
// The thing worth pointing at is usually inside an iframe — a Storybook story,
// a docs preview, an embedded editor. Two facts make that awkward:
//
//   - Events do not cross a frame boundary. A click inside the story is invisible
//     to every listener in the page above it, so the recorder's mark handler,
//     which only ever runs in the top frame, saw nothing at all. Measured: two
//     clicks inside a same-origin iframe produced zero marks.
//   - rrweb lives in ONE frame. tick.js emits through
//     rrweb.record.addCustomEvent, and there is no rrweb instance in a child
//     frame to emit through. (rrweb itself is fine: its iframe manager traverses
//     same-origin children and tracks their mutations. Measured: 15 of 15
//     attribute changes inside the child, identical to the top frame. So the
//     recorder does NOT need to be injected per-frame, and must not be — a
//     second rrweb.record() in the same tab would put two streams in one file.)
//
// So a child frame reports upward instead, over postMessage, which is the one
// channel that does cross the boundary. The top frame owns the recorder and
// does the actual emitting.
//
// Only same-origin frames are covered, and that is not a limitation of this
// file: the service worker registers content scripts against the top page's
// origin, so a cross-origin iframe never receives any rewalk script to begin
// with. The origin check below is therefore free — it rejects exactly the
// messages that cannot be ours, including a page trying to forge marks into
// its own recording.
(() => {
  if (window.__rewalkFrames || location.href === 'about:blank') return;

  const TAG = '__rewalk_frame';
  const isTop = window === window.top;
  let recording = false;
  const listeners = [];

  addEventListener('message', (e) => {
    const m = e.data;
    if (!m || m.tag !== TAG) return;
    if (e.origin !== location.origin) return;
    if (isTop) {
      switch (m.kind) {
        // A mark from a frame below. Recorded by the top frame's rrweb, stamped
        // with where it happened so the selector is resolvable against the right
        // document.
        case 'mark':
          try { window.__rewalkMark?.(m.mark.kind, { ...m.mark.payload, frame: { url: m.url } }); } catch (x) {}
          break;
        // "Is anyone recording?" — window.__rewalk is set by tick.js, which is
        // only injected while a recording is running.
        // Answered with the ARMED state too. A frame that loads after Tab was
        // pressed would otherwise never hear about it — armBelow() reaches the
        // frames that exist at the moment of the keystroke, and an iframe that
        // appears a second later is exactly the thing somebody is recording.
        case 'recording?':
          try { e.source?.postMessage({ tag: TAG, kind: 'recording', on: !!window.__rewalk, armed: armedHere }, e.origin); } catch (x) {}
          break;
        // Somebody pressed Tab down there. The HUD lives up HERE and only here,
        // so a child frame cannot reveal it on its own.
        case 'arm': armHere(); armBelow(); break;
      }
    } else if (m.kind === 'recording') {
      recording = !!m.on;
      if (m.armed) armHere();
      for (const fn of listeners) { try { fn(recording); } catch (x) {} }
    } else if (m.kind === 'armed') {
      // Down, and onward: armBelow only reaches direct children, so each frame
      // passes it to its own. 'arm' only ever goes up and 'armed' only ever
      // goes down, so the two cannot chase each other.
      armHere(); armBelow();
    }
  });

  // --- arming -----------------------------------------------------------------
  // Nothing rewalk draws appears until somebody asks for it, and the ask is one
  // keystroke in ONE frame. Everything that draws — the HUD in the top frame,
  // the lens in every frame — listens for this DOM event; this file is only the
  // part that gets it across the boundaries.
  let armedHere = false;
  const armHere = () => {
    if (armedHere) return;
    armedHere = true;
    try { document.dispatchEvent(new CustomEvent('__rewalk_arm')); } catch (x) {}
  };
  const armBelow = () => {
    for (let i = 0; i < window.frames.length; i++) {
      try { window.frames[i].postMessage({ tag: TAG, kind: 'armed' }, location.origin); } catch (x) {}
    }
  };

  /** Ask for the instruments, everywhere. Safe to call more than once. */
  const arm = () => {
    armHere();
    if (isTop) { armBelow(); return; }
    try { window.top.postMessage({ tag: TAG, kind: 'arm' }, location.origin); } catch (x) {}
  };

  /** Record a mark. In the top frame that is a direct call; below, a message. */
  const sendMark = (kind, payload) => {
    if (isTop) { try { window.__rewalkMark?.(kind, payload); } catch (x) {} return; }
    try {
      window.top.postMessage({ tag: TAG, kind: 'mark', url: location.href, mark: { kind, payload } },
        location.origin);
    } catch (x) {}
  };

  /**
   * Whether a recording is running, which only the top frame knows. Answers
   * synchronously up there and asynchronously below, so callers take a callback
   * and re-read `isRecording()` when they need it.
   */
  const onRecording = (fn) => {
    if (isTop) { try { fn(!!window.__rewalk); } catch (x) {} return; }
    listeners.push(fn);
    try { window.top.postMessage({ tag: TAG, kind: 'recording?' }, location.origin); } catch (x) {}
  };

  const isRecording = () => (isTop ? !!window.__rewalk : recording);

  // Stop has to travel down. `__rewalk_stop` is a DOM event dispatched by the
  // relay in the top frame, so a child frame never sees it and its lens would
  // keep drawing over a page nobody is recording any more.
  if (isTop) document.addEventListener('__rewalk_stop', () => {
    for (let i = 0; i < window.frames.length; i++) {
      try { window.frames[i].postMessage({ tag: TAG, kind: 'recording', on: false }, location.origin); } catch (x) {}
    }
  }, { once: true });

  window.__rewalkFrames = { isTop, sendMark, onRecording, isRecording, arm, isArmed: () => armedHere };
})();
