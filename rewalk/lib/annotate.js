// The comment overlay: pick elements, say what is wrong, send it to a session.
//
// Runs in the ISOLATED world (it needs chrome.runtime) on any page, whether or
// not a recording is running. This file is the behaviour — selection, the
// panel, sending, and the cross-frame protocol. lib/annotate-shell.js is the
// host element, the closed shadow root, and the positioning that survives
// whatever CSS the page has; the two are concatenated into one content script
// by chrome-ext/build.mjs.
//
// The selector must match what a mark would have recorded, or a comment sends
// an agent to a different node than the person pointed at — hence
// window.__rewalkSelector from lib/selector.js, the same source tick.js uses in
// the MAIN world.
(() => {
  if (window.__rewalkAnnotate || location.href === 'about:blank') return;

  const shell = window.__rewalkShell;
  const ROOT_ID = shell.ROOT_ID;
  const sel = window.__rewalkSelector;

  // Frames. A Storybook story, a docs preview, an embedded editor — the thing
  // worth commenting on is very often inside an iframe, and from the top frame
  // that whole region is one <iframe> element: clicking it selects the frame,
  // not the button inside it. So the overlay is injected into EVERY frame.
  //
  // Only the top frame draws the panel. Child frames are selection surfaces:
  // they ring what was picked in their own coordinate space (nobody else can —
  // rects are per-frame) and report the node up through the service worker,
  // which is the only thing that can talk to both. A second panel inside the
  // iframe would be two competing UIs for one comment.
  const isTop = window === window.top;
  let seq = 0;
  const myKey = () => `${isTop ? 'top' : 'f'}${Date.now().toString(36)}-${++seq}`;
  const tell = (msg) => { try { chrome.runtime.sendMessage(msg); } catch (e) {} };

  let shade = null, on = false;
  /** @type {{el: Element, s: string, key: string}[]} */
  let picked = [];
  /** Picks made in other frames — top frame only, listed but not ringed here. */
  let remote = [];
  let sessions = [], target = null, recording = null, sending = false, status = '', pending = false;

  const mk = (tag, css, text) => {
    const el = document.createElement(tag);
    if (css) el.style.cssText = css;
    if (text != null) el.textContent = text;
    return el;
  };

  // --- painting -------------------------------------------------------------
  // Rings are drawn INSIDE the shadow root over each element's rect, never on
  // the page's own nodes: setting style.outline on an app node would be an
  // attribute mutation, which is exactly what the resolver reads.
  let hoverBox = null;
  function paint() {
    if (!shade) return;
    shell.syncHost();
    for (const el of [...shade.querySelectorAll('.ring,.panel')]) el.remove();
    for (const p of picked) {
      if (!p.el.isConnected) continue;
      const r = p.el.getBoundingClientRect();
      const ring = mk('div', `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`);
      ring.className = 'ring';
      ring.appendChild(mk('b', '', p.s.length > 46 ? `${p.s.slice(0, 45)}…` : p.s));
      shade.appendChild(ring);
    }
    if (isTop) shell.clampPanel(shade.appendChild(panel()), recording ? 62 : 16);
  }

  /** What a picked element becomes on the wire. */
  const describe = (p) => ({
    key: p.key,
    s: p.s,
    at: p.at,
    text: (p.el.textContent || '').trim().slice(0, 120),
    snippet: (p.el.outerHTML || '').slice(0, 400),
    // The fiber walk lives in the MAIN world (tick.js publishes it there); the
    // ISOLATED world cannot reach it. A comment made during a recording still
    // gets component names, because the click that selected the node was also
    // recorded as a mark by the MAIN-world instruments.
    react: null,
    ...(isTop ? {} : { frame: { url: location.href } }),
  })

  function panel() {
    const p = mk('div');
    p.className = 'panel';
    const hd = mk('div'); hd.className = 'hd';
    hd.appendChild(Object.assign(mk('div'), { className: 'dot' }));
    hd.appendChild(mk('b', '', 'rewalk comment'));
    const esc = mk('span', 'margin-left:auto', 'esc to close');
    esc.className = 'hint';
    hd.appendChild(esc);
    p.appendChild(hd);

    const total = picked.length + remote.length;
    p.appendChild(Object.assign(mk('div', '', total
      ? `${total} element${total === 1 ? '' : 's'} selected — click more to add`
      : 'click the element(s) this is about'), { className: 'hint' }));

    if (picked.length || remote.length) {
      const list = mk('div'); list.className = 'nodes';
      for (const n of picked) {
        const row = mk('div'); row.className = 'node';
        row.appendChild(mk('span', '', n.s));
        const x = mk('button', '', '×');
        x.title = 'remove';
        x.onclick = (e) => { e.stopPropagation(); picked = picked.filter((q) => q !== n); paint(); };
        row.appendChild(x);
        list.appendChild(row);
      }
      // Picked in another frame. Its ring is drawn over there, so removing it
      // has to travel back the same way it came.
      for (const n of remote) {
        const row = mk('div'); row.className = 'node';
        const span = mk('span', '', n.s);
        span.title = n.frame?.url ?? '';
        row.appendChild(span);
        row.appendChild(mk('i', 'font-style:normal;color:#8b949e;flex:none', 'in frame'));
        const x = mk('button', '', '×');
        x.title = 'remove';
        x.onclick = (e) => {
          e.stopPropagation();
          remote = remote.filter((q) => q.key !== n.key);
          tell({ rewalk: 'drop', key: n.key });
          paint();
        };
        row.appendChild(x);
        list.appendChild(row);
      }
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
        // The herdr pane's own name first: it is what its owner recognises, and
        // without it three agents in one repo are three identical rows. Then
        // the status, because delivery is a pull — an idle session takes this
        // as soon as it is nudged, a busy one at its next tool call.
        const label = [s.pane_name || s.slug, s.agent,
          s.agent_status && s.agent_status !== 'idle' ? s.agent_status : null,
          s.discovered ? 'found' : null].filter(Boolean);
        const o = mk('option', '', label.join(' — '));
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
    if (i >= 0) {
      const [gone] = picked.splice(i, 1);
      if (!isTop) tell({ rewalk: 'unpick', key: gone.key });
      paint();
      return;
    }
    // When, not just what. Speech lags the thing it describes by a second or
    // two, which is what the resolver's window assumes; a typed comment lags
    // it by however long the person took to open this panel and write a
    // sentence. The click that picked the element is the moment that is
    // actually near the change, so it travels with the node.
    const p = { el, s: sel(el) || el.tagName.toLowerCase(), at: Date.now(), key: myKey() };
    picked.push(p);
    // A child frame has no panel to show this in; the top frame's does.
    if (!isTop) tell({ rewalk: 'pick', node: describe(p) });
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
    // Escape anywhere closes everywhere — pressing it inside an iframe must
    // not leave the panel up in the frame above.
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); tell({ rewalk: 'close' }); }
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
      nodes: [...picked.map(describe), ...remote].map(({ key, ...n }) => n),
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
        remote = [];
        // Close every frame, not just this one: the rings for anything picked
        // inside an iframe are drawn over there and would otherwise stay on
        // the page after the comment had been sent.
        setTimeout(() => { close(); tell({ rewalk: 'close' }); }, 2600);
      }
      paint();
    });
  }

  // --- open / close ---------------------------------------------------------
  function setSessions(list) {
    sessions = list ?? [];
    pending = false;
    // Default to the first, which the hub orders most-recently-active first.
    // Leaving it unset when there was more than one session meant the comment
    // travelled with no target at all — and a browser has no working directory
    // to fall back on, so the hub had no way to route it and it sat queued for
    // ever. A visible default that can be changed beats a silent black hole.
    target = sessions.find((s) => s.session_id === target)?.session_id
      ?? sessions[0]?.session_id ?? null;
    if (on) paint();
  }

  function open(state) {
    recording = state?.recording ?? null;
    pending = !!state?.pending;
    sessions = state?.sessions ?? [];
    // Default to the first, which the hub orders most-recently-active first.
    // Leaving it unset when there was more than one session meant the comment
    // travelled with no target at all — and a browser has no working directory
    // to fall back on, so the hub had no way to route it and it sat queued for
    // ever. A visible default that can be changed beats a silent black hole.
    target = sessions.find((s) => s.session_id === target)?.session_id
      ?? sessions[0]?.session_id ?? null;
    status = '';
    on = true;
    shade = shell.ensure();
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
    remote = [];
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
    shell.teardown();
    shade = null;
  }

  window.__rewalkAnnotate = { open, close, probe: () => ({ open: on, ...shell.probe() }), toggle: (state) => (on ? close() : open(state)) };
  window.__rewalkAnnotate.setSessions = setSessions;
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    switch (msg?.rewalk) {
      case 'annotate':
        window.__rewalkAnnotate.toggle(msg.state);
        // Only the top frame's answer decides whether the toggle opened or
        // closed; a child frame answering "on" would race it.
        reply({ ok: true, on, top: isTop });
        break;
      // The session list, arriving after the panel is already up.
      case 'sessions': setSessions(msg.sessions); reply({ ok: true }); break;
      // A pick made in another frame, relayed here by the service worker.
      case 'peer-pick':
        if (isTop && on && msg.node) { remote.push(msg.node); paint(); }
        reply({ ok: true });
        break;
      case 'peer-unpick':
        if (isTop) { remote = remote.filter((n) => n.key !== msg.key); paint(); }
        reply({ ok: true });
        break;
      // The top frame removed a pick that belongs to whichever frame owns it.
      case 'drop': {
        const before = picked.length;
        picked = picked.filter((p) => p.key !== msg.key);
        if (picked.length !== before) paint();
        reply({ ok: true });
        break;
      }
      case 'close': if (on) close(); reply({ ok: true }); break;
      default: return false;
    }
    return false;
  });
})();
