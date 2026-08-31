// The lens: one implementation of "put a ring on that element", for every
// surface that needs one.
//
// There used to be two. The pointing lens (recording) drew an indigo ring with
// a component chip from the MAIN world; the comment overlay drew green rings
// and a dashed amber hover box from the ISOLATED world. They disagreed about
// three things that matter:
//
//   - WHICH element. The lens ringed closest(INTERACTIVE), the same choice
//     tick.js's mark handler makes; the comment overlay ringed the literal
//     event target. Point at a close button and one names the button while the
//     other names the <svg> inside it. tick.js says out loud that these must
//     agree, and they did not.
//   - WHERE the ring lands. Only the comment overlay's host measured itself
//     (a `transform` or `contain: paint` on <html> makes it the containing
//     block for fixed descendants, so the host stretches to the whole document).
//     The pointing lens assumed position:fixed worked and was wrong on exactly
//     the pages that fix was written for.
//   - What it is called. The lens could name the React component, because the
//     fiber walk lives in the MAIN world. The comment overlay could not.
//
// Separate worlds cannot share an object, so — like lib/selector.js — they
// share this source text and each evaluates its own copy. `create()` takes the
// host id because two copies can be live in one frame at once (MAIN drawing the
// recording lens, ISOLATED drawing comment picks) and two elements cannot carry
// the same id.
//
// Non-negotiables, inherited from both predecessors:
//   - Invisible to the recorder: class="rr-block" (rrweb skips it), an id that
//     tick.js and deltas.mjs exclude by name, and a CLOSED shadow root so rrweb
//     cannot traverse in even if the class fails.
//   - NO css transition or animation, anywhere. motion.js discovers work
//     through transitionrun and getAnimations(); an instrument that animates is
//     an instrument that measures itself.
//   - Nothing is ever written to the page's own nodes. Ringing a selection by
//     setting style.outline on it would be an attribute mutation, which is
//     exactly what the resolver reads.
(() => {
  if (window.__rewalkLens || location.href === 'about:blank') return;

  // Byte-for-byte the closest() list in tick.js's mark handler. A comment, a
  // mark and the ring a person saw before making either must name one element.
  const INTERACTIVE = 'button,a,[role=button],[role=tab],input,select,textarea,[data-line]';

  // Every id the instruments hang off, excluded from the recording by name.
  // tick.js, deltas.mjs and the drivers all read this list from here so it
  // cannot drift; deltas.mjs additionally keeps the retired `rewalk-hud-hl`,
  // because sessions recorded before this file existed still carry that id.
  const EXCLUDE = '#rewalk-hud,#rewalk-hud-toast,#rewalk-lens,#rewalk-comment,#rewalk-cue';

  // The palette. Indigo is the resting state everywhere — hover, and anything
  // already picked. Amber means a point is armed (⌥ held). Green is only ever a
  // flash confirming a click landed; nothing rests green.
  const INDIGO = '124,134,255', AMBER = '210,153,34', GREEN = '63,185,80';

  /** The element a click here would actually be about. */
  const pickTarget = (el) => {
    if (!el || el.nodeType !== 1) return null;
    if (el === document.documentElement || el === document.body) return null;
    return (el.closest && el.closest(INTERACTIVE)) || el;
  };

  /** Is this node part of any rewalk instrument? */
  const isOurs = (el) => !!(el && el.closest && el.closest(EXCLUDE));

  const CSS = `
    :host{all:initial}
    *{box-sizing:border-box;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
    .ring{position:absolute;left:0;top:0;box-sizing:border-box;pointer-events:none;will-change:transform}
    .chip{position:absolute;left:0;top:0;font:11px/1.2 ui-sans-serif,system-ui,sans-serif;color:#e6edf3;
      background:rgba(14,17,22,.94);border:1px solid #2a323d;border-radius:6px;padding:4px 7px;
      white-space:nowrap;max-width:380px;overflow:hidden;text-overflow:ellipsis;pointer-events:none;will-change:transform}
    .chip b{font-weight:600;color:#a5adff}
    .chip i{font-style:normal;color:#8b949e}
    .pin{position:absolute;border:1.5px solid rgba(${INDIGO},.9);border-radius:5px;pointer-events:none}
    .pin b{position:absolute;left:0;top:-17px;background:rgba(${INDIGO},.95);color:#0e1116;
      font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;padding:0 5px;border-radius:3px;
      white-space:nowrap;font-weight:600;max-width:340px;overflow:hidden;text-overflow:ellipsis}
  `;

  function create({ id = 'rewalk-lens', isolateKeys = false, extraCss = '' } = {}) {
    let host = null, shade = null;
    let ring = null, chip = null, chipName = null, chipRest = null;
    let target = null, mode = INDIGO, radius = 7;
    let flashColor = null, flashUntil = 0;
    let raf = 0, dead = false, hidden = false;
    const cur = { x: 0, y: 0, w: 0, h: 0, o: 0 };
    let painted = '';

    function ensure() {
      if (host && host.isConnected) return shade;
      lastSync = '';                                 // a fresh host has measured nothing
      host = document.createElement('div');
      host.id = id;
      host.className = 'rr-block';
      host.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:100%;height:100%;' +
        'z-index:2147483646;pointer-events:none';
      shade = host.attachShadow({ mode: 'closed' });
      const style = document.createElement('style');
      style.textContent = CSS + extraCss;
      shade.appendChild(style);

      // Keystrokes stop at the shadow boundary. A page listening on document for
      // single-key shortcuts sees our typing otherwise, and — worse — sees it as
      // safe to act on: shadow DOM retargets the event, so at document level
      // event.target is this host <div>, not a <textarea>, and the usual "don't
      // steal keys from inputs" guard every such page has does not fire. Measured
      // in Storybook: typing "m" in the comment box triggered its shortcut
      // instead of entering a character. Bubble phase, so the field itself has
      // already had the key, and capture-phase listeners still run.
      if (isolateKeys)
        for (const type of ['keydown', 'keyup', 'keypress', 'input', 'paste', 'beforeinput'])
          shade.addEventListener(type, (e) => e.stopPropagation());

      ring = document.createElement('div');
      ring.className = 'ring';
      chip = document.createElement('div');
      chip.className = 'chip';
      chipName = document.createElement('b');
      chipRest = document.createElement('i');
      chip.appendChild(chipName);
      chip.appendChild(chipRest);
      ring.style.opacity = '0';
      chip.style.opacity = '0';
      shade.appendChild(ring);
      shade.appendChild(chip);

      const attach = () => document.documentElement.appendChild(host);
      document.documentElement ? attach() : addEventListener('DOMContentLoaded', attach);
      return shade;
    }

    // Keep the host exactly over the viewport, and do not assume position:fixed
    // can do that. A transform or `contain: paint` on <html> makes it the
    // containing block for fixed descendants, so the host stretches to the whole
    // document instead: measured on a 4000px page, host.top = -1500 and
    // height = 4000, which put the comment panel 1800px below the fold.
    // Everything inside is positioned in viewport coordinates (rects come from
    // getBoundingClientRect), so the host has to BE the viewport. When fixed
    // does not deliver that, fall back to absolute in page coordinates.
    //
    // Called from the paint loop, not just when rings are rebuilt. The pointing
    // lens never called it at all while it had its own host, which is why a ring
    // on a page with a transformed <html> sat hundreds of pixels from the thing
    // it was ringing. Keyed on scroll and viewport size so the common frame
    // costs a string compare instead of a forced layout.
    let lastSync = '';
    function syncHost() {
      if (!host) return;
      const key = `${scrollX},${scrollY},${innerWidth},${innerHeight}`;
      if (key === lastSync) return;
      lastSync = key;
      host.style.position = 'fixed';
      host.style.left = '0'; host.style.top = '0';
      host.style.width = '100%'; host.style.height = '100%';
      const r = host.getBoundingClientRect();
      if (Math.abs(r.top) > 1 || Math.abs(r.height - innerHeight) > 1) {
        host.style.position = 'absolute';
        host.style.left = `${scrollX}px`;
        host.style.top = `${scrollY}px`;
        host.style.width = `${innerWidth}px`;
        host.style.height = `${innerHeight}px`;
      }
    }

    // Two passes, and no arithmetic that depends on knowing the containing
    // block. Park the panel at top:0 left:0, read where the viewport says that
    // actually is, then set top/left to the offsets that move it to the corner.
    //
    // The obvious version used offsetTop/offsetLeft to find the current
    // position, which is wrong inside a shadow root: offsetParent is null when
    // the containing block is the host, and offsetTop is then measured from the
    // initial containing block instead — off by the page's scroll, on exactly
    // the long pages where the bug showed up.
    //
    // `gap` is the space left at the bottom: 62px while recording, because the
    // mic HUD sits at bottom:14 and is ~34px tall and is how a person knows the
    // microphone is being heard.
    function clampPanel(p, gap = 16) {
      if (!p) return;
      p.style.right = 'auto';
      p.style.bottom = 'auto';
      p.style.top = '0px';
      p.style.left = '0px';
      const r = p.getBoundingClientRect();
      if (!r.height) return;                        // not laid out yet
      p.style.top = `${Math.max(8 - r.top, innerHeight - gap - r.height - r.top)}px`;
      p.style.left = `${Math.max(8 - r.left, innerWidth - 16 - r.width - r.left)}px`;
    }

    const paintColor = (color) => {
      if (painted === color) return;
      painted = color;
      ring.style.border = `1.5px solid rgba(${color},.9)`;
    };

    const wake = () => { if (!dead && !hidden && !raf) raf = requestAnimationFrame(frame); };

    function frame() {
      raf = 0;
      if (!ring) return;
      syncHost();
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

      if (flashColor && now < flashUntil) { paintColor(flashColor); settled = false; }
      else { flashColor = null; paintColor(mode); }

      // chip rides the ring: above it, or below when the top is off screen
      if (cur.o > 0.05) {
        const above = cur.y - chip.offsetHeight - 7;
        chip.style.transform = `translate(${Math.max(6, Math.min(cur.x, innerWidth - chip.offsetWidth - 6))}px,` +
          `${above > 4 ? above : cur.y + cur.h + 7}px)`;
      }
      chip.style.opacity = String(cur.o * 0.97);

      if (!settled) wake();
    }

    /** Follow this element. Pass null to fade the ring out. */
    function track(el) {
      if (el === target) return;
      target = el;
      if (el) {
        const br = parseFloat(getComputedStyle(el).borderTopLeftRadius);
        radius = (Number.isFinite(br) && br > 0 ? Math.min(br, 24) : 5) + 2;
      }
      wake();
    }

    /** Chip text: a component name, then whatever else identifies the node. */
    function label(name, rest) {
      if (!chipName) return;
      chipName.textContent = name || '';
      chipRest.textContent = (name && rest ? ' — ' : '') + (rest || '');
    }

    const setMode = (color) => { if (color !== mode) { mode = color; wake(); } };
    const flash = (color, ms = 240) => { flashColor = color; flashUntil = performance.now() + ms; wake(); };

    /**
     * Static rings for elements that are already chosen, drawn alongside the
     * one that follows the pointer. Rebuilt wholesale: the rects are viewport
     * relative, so anything that scrolls invalidates all of them at once.
     */
    function pin(items) {
      if (!shade) return;
      for (const el of [...shade.querySelectorAll('.pin')]) el.remove();
      syncHost();
      for (const it of items || []) {
        if (!it.el || !it.el.isConnected) continue;
        const r = it.el.getBoundingClientRect();
        const box = document.createElement('div');
        box.className = 'pin';
        box.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;
        if (it.text) {
          const b = document.createElement('b');
          b.textContent = it.text.length > 46 ? `${it.text.slice(0, 45)}…` : it.text;
          box.appendChild(b);
        }
        shade.appendChild(box);
      }
    }

    /** Go invisible without tearing down — the recording lens while commenting. */
    function setHidden(v) {
      hidden = !!v;
      if (host) host.style.display = hidden ? 'none' : '';
      if (hidden) { target = null; if (raf) cancelAnimationFrame(raf); raf = 0; }
      else wake();
    }

    // What the overlay actually measures, for when a page puts it somewhere
    // unexpected. The shadow root is closed on purpose, so without this there is
    // no way to ask from a console. Read-only.
    function probe() {
      if (!host) return { open: false };
      const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
      const p = shade && shade.querySelector('.panel');
      const cs = getComputedStyle(document.documentElement);
      return {
        id,
        viewport: { w: innerWidth, h: innerHeight, scrollY: Math.round(scrollY) },
        host: { ...rect(host), position: getComputedStyle(host).position },
        panel: p ? rect(p) : null,
        target: target ? (window.__rewalkSelector?.(target) ?? target.tagName.toLowerCase()) : null,
        html: { transform: cs.transform, contain: cs.contain, zoom: cs.zoom },
        body: { transform: getComputedStyle(document.body).transform },
      };
    }

    function teardown() {
      dead = true;
      target = null;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      try { host && host.remove(); } catch (e) {}
      host = null; shade = null; ring = null; chip = null;
      dead = false;                                  // ensure() can revive it
    }

    return { ensure, syncHost, clampPanel, track, label, setMode, flash, pin,
      setHidden, probe, teardown, wake,
      root: () => shade, el: () => host,
      target: () => target };
  }

  window.__rewalkLens = { create, pickTarget, isOurs, INTERACTIVE, EXCLUDE, INDIGO, AMBER, GREEN };
})();
