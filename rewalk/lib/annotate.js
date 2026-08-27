// The comment overlay: pick elements, say what is wrong, send it to a session.
//
// Runs in the ISOLATED world (it needs chrome.runtime) on any page, whether or
// not a recording is running. Three constraints shape everything below, and
// none of them are cosmetic:
//
// 1. **It must be invisible to the recorder.** rrweb serialises the shared DOM,
//    so an overlay that draws itself into the page would show up in the stream
//    as the rarest, most recent change in every window — the instrument
//    outscoring what it measures, the same trap the teleprompter and the HUD
//    already had to be kept out of. The whole UI lives in ONE host element that
//    carries class="rr-block" (rrweb skips it) and id="rewalk-comment" (which
//    tick.js, deltas.mjs and highlight.js all exclude by name), with a closed
//    shadow root so the page's CSS cannot reach in and its own CSS cannot leak
//    out. Nothing here has a transition or an animation, because motion.js
//    discovers work through transitionrun and getAnimations().
//
// 2. **It must not touch the page's own nodes.** Ringing a selected element by
//    setting style.outline on it would be an attribute mutation on an app node,
//    which is exactly what the resolver reads. Selection rings are absolutely
//    positioned divs drawn INSIDE the shadow root over each element's rect, so
//    the app's DOM is never written to at all.
//
// 3. **The selector must match what a mark would have recorded.** Hence
//    window.__rewalkSelector from lib/selector.js, the same source tick.js uses
//    in the MAIN world.
(() => {
  if (window.__rewalkAnnotate || location.href === 'about:blank') return;

  const ROOT_ID = 'rewalk-comment';
  const sel = window.__rewalkSelector;

  let host = null, shade = null, on = false;
  /** @type {{el: Element, s: string}[]} */
  let picked = [];
  let sessions = [], target = null, recording = null, sending = false, status = '', pending = false;

  const mk = (tag, css, text) => {
    const el = document.createElement(tag);
    if (css) el.style.cssText = css;
    if (text != null) el.textContent = text;
    return el;
  };

  // --- the shell ------------------------------------------------------------
  function ensureHost() {
    if (host && host.isConnected) return;
    host = document.createElement('div');
    host.id = ROOT_ID;
    host.className = 'rr-block';
    host.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:100%;height:100%;z-index:2147483647;pointer-events:none';
    shade = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    // No transitions, no animations, no :hover that moves anything: motion.js
    // must not be able to discover this overlay as work the page did.
    style.textContent = `
      :host{all:initial}
      *{box-sizing:border-box;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
      .ring{position:absolute;border:2px solid #3fb950;border-radius:3px;pointer-events:none}
      .ring b{position:absolute;left:0;top:-18px;background:#3fb950;color:#0e1116;font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;padding:0 5px;border-radius:3px;white-space:nowrap;font-weight:600}
      .hover{position:absolute;border:1px dashed #d29922;border-radius:3px;pointer-events:none}
      .panel{position:absolute;right:16px;bottom:16px;width:360px;max-height:78vh;overflow:auto;pointer-events:auto;
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
    shade.appendChild(style);
    const attach = () => document.documentElement.appendChild(host);
    document.documentElement ? attach() : addEventListener('DOMContentLoaded', attach);
  }

  // Keep the host exactly over the viewport, and do not assume position:fixed
  // can do that. A transform or `contain: paint` on <html> makes it the
  // containing block for fixed descendants, so the host stretches to the whole
  // document instead: measured on a 4000px page, host.top = -1500 and
  // height = 4000, which put the comment panel 1800px below the fold — the
  // reported bug. Everything inside is positioned in viewport coordinates
  // (rings come from getBoundingClientRect), so the host has to BE the
  // viewport. When fixed does not deliver that, fall back to absolute in page
  // coordinates and re-place it as the page scrolls.
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

  // --- painting -------------------------------------------------------------
  let hoverBox = null;
  function paint() {
    if (!shade) return;
    syncHost();
    for (const el of [...shade.querySelectorAll('.ring,.panel')]) el.remove();
    for (const p of picked) {
      if (!p.el.isConnected) continue;
      const r = p.el.getBoundingClientRect();
      const ring = mk('div', `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`);
      ring.className = 'ring';
      const tag = mk('b', '', p.s.length > 46 ? p.s.slice(0, 45) + '…' : p.s);
      ring.appendChild(tag);
      shade.appendChild(ring);
    }
    shade.appendChild(panel());
  }

  function panel() {
    const p = mk('div');
    p.className = 'panel';
    // The recording HUD sits at right:14px bottom:14px and is ~34px tall. It
    // is how a person knows the microphone is actually being heard, so the
    // panel must not sit on top of it while a recording is running.
    if (recording) p.style.bottom = '62px';
    const hd = mk('div'); hd.className = 'hd';
    hd.appendChild(Object.assign(mk('div'), { className: 'dot' }));
    hd.appendChild(mk('b', '', 'rewalk comment'));
    const esc = mk('span', 'margin-left:auto', 'esc to close');
    esc.className = 'hint';
    hd.appendChild(esc);
    p.appendChild(hd);

    p.appendChild(Object.assign(mk('div', '', picked.length
      ? `${picked.length} element${picked.length === 1 ? '' : 's'} selected — click more to add`
      : 'click the element(s) this is about'), { className: 'hint' }));

    if (picked.length) {
      const list = mk('div'); list.className = 'nodes';
      picked.forEach((n, i) => {
        const row = mk('div'); row.className = 'node';
        row.appendChild(mk('span', '', n.s));
        const x = mk('button', '', '×');
        x.title = 'remove';
        x.onclick = (e) => { e.stopPropagation(); picked.splice(i, 1); paint(); };
        row.appendChild(x);
        list.appendChild(row);
      });
      p.appendChild(list);
    }

    const ta = mk('textarea');
    ta.placeholder = 'what is wrong with it?';
    ta.value = draft;
    ta.oninput = () => { draft = ta.value; const b = shade.querySelector('button.send'); if (b) b.disabled = !draft.trim() || sending; };
    p.appendChild(ta);

    const picker = mk('select');
    if (!sessions.length) {
      // Starting the native host and asking the hub takes a moment. The panel
      // opens first and fills this in when the answer arrives — waiting for it
      // before showing anything left the toolbar popup hanging open with a
      // dead button while a process started.
      const o = mk('option', '', pending ? 'looking for agent sessions…' : 'no agent session is running');
      o.value = '';
      picker.appendChild(o);
      picker.disabled = true;
    } else {
      for (const s of sessions) {
        const o = mk('option', '', `${s.slug} — ${s.agent}${s.discovered ? ' (found)' : ''}`);
        o.value = s.session_id;
        if (target === s.session_id) o.selected = true;
        picker.appendChild(o);
      }
    }
    picker.onchange = () => { target = picker.value || null; };
    p.appendChild(picker);

    if (recording) {
      const r = mk('div', '', 'recording — sending stops it, then the session finishes and the comment follows with its replay');
      r.className = 'rec';
      p.appendChild(r);
    }

    const row = mk('div'); row.className = 'row';
    const send = mk('button', '', recording ? 'stop recording & send' : 'send');
    send.className = 'send';
    send.disabled = !draft.trim() || sending;
    send.onclick = submit;
    row.appendChild(send);
    const cancel = mk('button', '', 'cancel');
    cancel.className = 'ghost';
    cancel.onclick = () => close();
    row.appendChild(cancel);
    p.appendChild(row);

    if (status) {
      const s = mk('div', '', status.text);
      s.className = `status ${status.kind ?? ''}`;
      p.appendChild(s);
    }
    return p;
  }

  let draft = '';

  // --- selection ------------------------------------------------------------
  // Capture phase, and every event is stopped: in annotate mode a click means
  // "this element", never what the page would have done with it.
  const inOverlay = (el) => !!(el && el.closest && el.closest(`#${ROOT_ID}`));

  // Tell the recorder (MAIN world, tick.js) that clicks are selections now.
  // stopImmediatePropagation cannot do this job: tick.js registers its capture
  // listener at document_start, so it runs BEFORE this script's and has
  // already queued the mark by the time anything here could stop the event.
  // Measured: picking two elements to comment on left two `click` marks in the
  // session, for clicks the app never received. The DOM is the only channel
  // the two worlds share, same as the batch transport.
  const tellRecorder = (state) => {
    try { document.dispatchEvent(new CustomEvent('__rewalk_annotate', { detail: state })); } catch (e) {}
  };

  const onClick = (e) => {
    if (!on || inOverlay(e.target)) return;
    e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation();
    const el = e.target;
    if (!el || el.nodeType !== 1) return;
    const i = picked.findIndex((p) => p.el === el);
    if (i >= 0) picked.splice(i, 1);
    // When, not just what. Speech lags the thing it describes by a second or
    // two, which is what the resolver's window assumes; a typed comment lags
    // it by however long the person took to open this panel and write a
    // sentence. The click that picked the element is the moment that is
    // actually near the change, so it travels with the node.
    else picked.push({ el, s: sel(el) || el.tagName.toLowerCase(), at: Date.now() });
    paint();
  };
  const swallow = (e) => { if (on && !inOverlay(e.target)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); } };

  const onMove = (e) => {
    if (!on || !shade) return;
    if (hoverBox) { hoverBox.remove(); hoverBox = null; }
    if (inOverlay(e.target) || !e.target || e.target.nodeType !== 1) return;
    const r = e.target.getBoundingClientRect();
    hoverBox = mk('div', `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`);
    hoverBox.className = 'hover';
    shade.appendChild(hoverBox);
  };

  const onKey = (e) => {
    if (!on) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  };
  // Rects are viewport-relative, so anything that moves the page invalidates
  // every ring on screen.
  const onScroll = () => { if (on) paint(); };

  // --- sending --------------------------------------------------------------
  function submit() {
    if (sending || !draft.trim()) return;
    sending = true;
    status = { text: 'sending…' };
    paint();
    const payload = {
      text: draft.trim(),
      nodes: picked.map((p) => ({
        s: p.s,
        at: p.at,
        text: (p.el.textContent || '').trim().slice(0, 120),
        snippet: (p.el.outerHTML || '').slice(0, 400),
        // The fiber walk lives in the MAIN world (tick.js publishes it there);
        // the ISOLATED world cannot reach it. A comment made during a recording
        // still gets component names, because the click that selected the node
        // was also recorded as a mark by the MAIN-world instruments.
        react: null,
      })),
      page: { url: location.href, title: document.title },
      target,
    };
    chrome.runtime.sendMessage({ rewalk: 'comment', payload }, (res) => {
      sending = false;
      if (chrome.runtime.lastError || !res) {
        status = { text: 'the extension could not be reached — reload the page after updating rewalk', kind: 'err' };
      } else if (!res.ok) {
        status = { text: res.error || 'refused', kind: 'err' };
      } else {
        // Say what actually happens next. Delivery is a pull: the comment waits
        // for that session's next tool call or turn end, and an idle session
        // fires no hooks at all. Claiming "sent" would be a lie.
        status = { text: res.status === 'held'
          ? `${res.id} — held until this recording finishes, then it goes to the session with its replay`
          : `${res.id} — queued; it arrives at the session's next tool call or turn end`, kind: 'ok' };
        draft = '';
        picked = [];
        setTimeout(() => close(), 2600);
      }
      paint();
    });
  }

  // --- open / close ---------------------------------------------------------
  function setSessions(list) {
    sessions = list ?? [];
    pending = false;
    target = sessions.find((s) => s.session_id === target)?.session_id
      ?? (sessions.length === 1 ? sessions[0].session_id : null);
    if (on) paint();
  }

  function open(state) {
    recording = state?.recording ?? null;
    pending = !!state?.pending;
    sessions = state?.sessions ?? [];
    target = sessions.find((s) => s.session_id === target)?.session_id
      ?? (sessions.length === 1 ? sessions[0].session_id : null);
    status = '';
    on = true;
    ensureHost();
    // The host spans the viewport so rings can be drawn anywhere in it, which
    // means it MUST stay pointer-events:none — with 'auto' it swallowed every
    // click before the page ever saw one, so nothing could be selected and the
    // recorder logged a click on the overlay itself. Only .panel takes events.
    // Measured: two clicks meant for #lens and #body both landed on
    // #rewalk-comment and the selection list stayed empty.
    tellRecorder('on');
    addEventListener('click', onClick, true);
    addEventListener('mousedown', swallow, true);
    addEventListener('mouseup', swallow, true);
    addEventListener('mousemove', onMove, true);
    addEventListener('keydown', onKey, true);
    addEventListener('scroll', onScroll, true);
    addEventListener('resize', onScroll, true);
    paint();
  }

  function close() {
    on = false;
    tellRecorder('off');
    picked = [];
    draft = '';
    status = '';
    removeEventListener('click', onClick, true);
    removeEventListener('mousedown', swallow, true);
    removeEventListener('mouseup', swallow, true);
    removeEventListener('mousemove', onMove, true);
    removeEventListener('keydown', onKey, true);
    removeEventListener('scroll', onScroll, true);
    removeEventListener('resize', onScroll, true);
    if (hoverBox) { hoverBox.remove(); hoverBox = null; }
    try { host && host.remove() } catch (e) {}
    host = null; shade = null;
  }

  window.__rewalkAnnotate = { open, close, toggle: (state) => (on ? close() : open(state)) };
  window.__rewalkAnnotate.setSessions = setSessions;
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg?.rewalk === 'annotate') { window.__rewalkAnnotate.toggle(msg.state); reply({ ok: true, on }); }
    // The session list, arriving after the panel is already up.
    if (msg?.rewalk === 'sessions') { setSessions(msg.sessions); reply({ ok: true }); }
    return false;
  });
})();
