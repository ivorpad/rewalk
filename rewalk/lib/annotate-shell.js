// The comment overlay's shell: one host element, a closed shadow root, and the
// job of keeping both exactly over the viewport on pages that fight it.
//
// Split out of lib/annotate.js because it answers a different question. This
// file is about surviving whatever CSS the host page has; annotate.js is about
// what the person is doing. They are concatenated into one content script by
// chrome-ext/build.mjs and talk through window.__rewalkShell.
//
// Two constraints here are not cosmetic:
//
// - **Invisible to the recorder.** rrweb serialises the shared DOM, so an
//   overlay that drew itself into the page would be the rarest, most recent
//   change in every window — the instrument outscoring what it measures, the
//   trap the teleprompter and the HUD already had to be kept out of. Hence ONE
//   host carrying class="rr-block" (rrweb skips it) and id="rewalk-comment"
//   (tick.js, deltas.mjs and highlight.js exclude it by name), a closed shadow
//   root so rrweb cannot traverse in even if the class failed, and no CSS
//   transition or animation anywhere, because motion.js discovers work through
//   transitionrun and getAnimations().
// - **Nothing is written to the page's own nodes.** Ringing a selection by
//   setting style.outline on it would be an attribute mutation on an app node,
//   which is exactly what the resolver reads.
(() => {
  if (window.__rewalkShell || location.href === 'about:blank') return;

  const ROOT_ID = 'rewalk-comment';
  let host = null, shade = null;

  const CSS = `
    :host{all:initial}
    *{box-sizing:border-box;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
    .ring{position:absolute;border:2px solid #3fb950;border-radius:3px;pointer-events:none}
    .ring b{position:absolute;left:0;top:-18px;background:#3fb950;color:#0e1116;font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;padding:0 5px;border-radius:3px;white-space:nowrap;font-weight:600}
    .hover{position:absolute;border:1px dashed #d29922;border-radius:3px;pointer-events:none}
    .panel{position:absolute;width:360px;max-height:78vh;overflow:auto;pointer-events:auto;
      background:#0e1116;color:#e6edf3;border:1px solid #2a323d;border-radius:10px;padding:12px;font-size:13px;line-height:1.5;
      box-shadow:0 8px 28px rgba(0,0,0,.45)}
    .hd{display:flex;align-items:center;gap:8px;margin-bottom:8px}
    .hd b{font-size:13px}
    .dot{width:8px;height:8px;border-radius:50%;background:#3fb950;flex:none}
    .hint{color:#8b949e;font-size:12px}
    .nodes{margin:8px 0;display:flex;flex-direction:column;gap:4px}
    .node{display:flex;gap:6px;align-items:center;background:#161b22;border:1px solid #232a33;border-radius:6px;padding:4px 7px;
      font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#e6edf3}
    .node span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
    .node button{background:none;border:0;color:#8b949e;cursor:pointer;font-size:14px;padding:0 2px;line-height:1}
    textarea{width:100%;min-height:64px;background:#161b22;color:#e6edf3;border:1px solid #2a323d;border-radius:6px;
      padding:7px;font:13px/1.5 inherit;resize:vertical}
    textarea:focus{outline:1px solid #3fb950}
    select{width:100%;background:#161b22;color:#e6edf3;border:1px solid #2a323d;border-radius:6px;padding:6px;font:12px inherit;margin-top:7px}
    .row{display:flex;gap:8px;align-items:center;margin-top:9px}
    button.send{flex:1;background:#3fb950;color:#0e1116;border:0;border-radius:6px;padding:8px 10px;font:600 13px inherit;cursor:pointer}
    button.send[disabled]{background:#2a323d;color:#8b949e;cursor:default}
    button.ghost{background:none;border:1px solid #2a323d;color:#8b949e;border-radius:6px;padding:8px 10px;font:13px inherit;cursor:pointer}
    .status{margin-top:8px;font-size:12px;color:#8b949e}
    .status.err{color:#f85149}
    .status.ok{color:#3fb950}
    .rec{background:#161b22;border:1px solid #2a323d;border-radius:6px;padding:6px 8px;margin-top:8px;font-size:12px;color:#d29922}
  `;

  function ensure() {
    if (host && host.isConnected) return shade;
    host = document.createElement('div');
    host.id = ROOT_ID;
    host.className = 'rr-block';
    host.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:100%;height:100%;z-index:2147483647;pointer-events:none';
    shade = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    shade.appendChild(style);

    // Keystrokes stop at the shadow boundary. A page listening on document for
    // single-key shortcuts sees our typing otherwise, and — worse — sees it as
    // safe to act on: shadow DOM retargets the event, so at document level
    // event.target is this host <div>, not a <textarea>, and the usual "don't
    // steal keys from inputs" guard every such page has does not fire. Measured
    // in Storybook: typing "m" in the comment box triggered its shortcut
    // instead of entering a character. Bubble phase, so the field itself has
    // already had the key, and capture-phase listeners (annotate.js's Escape)
    // still run.
    for (const type of ['keydown', 'keyup', 'keypress', 'input', 'paste', 'beforeinput'])
      shade.addEventListener(type, (e) => e.stopPropagation());

    const attach = () => document.documentElement.appendChild(host);
    document.documentElement ? attach() : addEventListener('DOMContentLoaded', attach);
    return shade;
  }

  // Keep the host exactly over the viewport, and do not assume position:fixed
  // can do that. A transform or `contain: paint` on <html> makes it the
  // containing block for fixed descendants, so the host stretches to the whole
  // document instead: measured on a 4000px page, host.top = -1500 and
  // height = 4000, which put the comment panel 1800px below the fold. Everything
  // inside is positioned in viewport coordinates (rings come from
  // getBoundingClientRect), so the host has to BE the viewport. When fixed does
  // not deliver that, fall back to absolute in page coordinates.
  function syncHost() {
    if (!host) return;
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

  // Two passes, and no arithmetic that depends on knowing the containing block.
  // Park the panel at top:0 left:0, read where the viewport says that actually
  // is, then set top/left to the offsets that move it from there to the corner.
  //
  // The obvious version of this used offsetTop/offsetLeft to find the current
  // position, which is wrong inside a shadow root: offsetParent is null when
  // the containing block is the host, and offsetTop is then measured from the
  // initial containing block instead — off by the page's scroll, on exactly the
  // long pages where the bug showed up.
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

  // What the overlay actually measures, for when a page puts it somewhere
  // unexpected. The shadow root is closed on purpose, so without this there is
  // no way to ask from a console. Read-only.
  function probe() {
    if (!host) return { open: false };
    const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
    const p = shade && shade.querySelector('.panel');
    const cs = getComputedStyle(document.documentElement);
    return {
      viewport: { w: innerWidth, h: innerHeight, scrollY: Math.round(scrollY) },
      host: { ...rect(host), position: getComputedStyle(host).position },
      panel: p ? rect(p) : null,
      html: { transform: cs.transform, contain: cs.contain, zoom: cs.zoom },
      body: { transform: getComputedStyle(document.body).transform },
    };
  }

  function teardown() {
    try { host && host.remove(); } catch (e) {}
    host = null; shade = null;
  }

  window.__rewalkShell = { ROOT_ID, ensure, syncHost, clampPanel, probe, teardown,
    root: () => shade, el: () => host };
})();
