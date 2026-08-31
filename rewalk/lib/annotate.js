// The comment overlay: pick elements, say what is wrong, send it to a session.
//
// Runs in the ISOLATED world (it needs chrome.runtime) on any page, whether or
// not a recording is running. This file is the behaviour — selection, the
// panel, sending, and the cross-frame protocol. The rings, the hover ring, the
// host element and the positioning that survives whatever CSS the page has all
// come from lib/lens.js, which the recording lens draws with too; this file
// used to carry a second implementation of all of it, in different colours,
// that disagreed with the recorder about which element a click was even about.
//
// Two things must match what a mark would have recorded, or a comment sends an
// agent to a different node than the person pointed at:
//   - the NAME: window.__rewalkSelector, from lib/selector.js, the same source
//     tick.js evaluates in the MAIN world.
//   - the ELEMENT: lens.pickTarget, the same closest() list tick.js's mark
//     handler uses. This file previously took the literal event target, so
//     clicking a button's inner <svg> filed a comment about the <svg>.
(() => {
  if (window.__rewalkAnnotate || location.href === 'about:blank') return;

  const L = window.__rewalkLens;
  const sel = window.__rewalkSelector;
  if (!L || !sel) return;

  const ROOT_ID = 'rewalk-comment';

  // Only the panel lives here; every ring style is lens.js's. `all:initial` on
  // the host plus a closed shadow root means none of this can leak either way.
  const PANEL_CSS = `
    .panel{position:absolute;width:360px;max-height:78vh;overflow:auto;pointer-events:auto;
      background:#0e1116;color:#e6edf3;border:1px solid #2a323d;border-radius:10px;padding:12px;font-size:13px;line-height:1.5;
      box-shadow:0 8px 28px rgba(0,0,0,.45)}
    .hd{display:flex;align-items:center;gap:8px;margin-bottom:8px}
    .hd b{font-size:13px}
    .dot{width:8px;height:8px;border-radius:50%;background:rgba(124,134,255,.95);flex:none}
    .hint{color:#8b949e;font-size:12px}
    .nodes{margin:8px 0;display:flex;flex-direction:column;gap:4px}
    .node{display:flex;gap:6px;align-items:center;background:#161b22;border:1px solid #232a33;border-radius:6px;padding:4px 7px;
      font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:#e6edf3}
    .node span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
    .node button{background:none;border:0;color:#8b949e;cursor:pointer;font-size:14px;padding:0 2px;line-height:1}
    textarea{width:100%;min-height:64px;background:#161b22;color:#e6edf3;border:1px solid #2a323d;border-radius:6px;
      padding:7px;font:13px/1.5 inherit;resize:vertical}
    textarea:focus{outline:1px solid rgba(124,134,255,.9)}
    select{width:100%;background:#161b22;color:#e6edf3;border:1px solid #2a323d;border-radius:6px;padding:6px;font:12px inherit;margin-top:7px}
    .row{display:flex;gap:8px;align-items:center;margin-top:9px}
    button.send{flex:1;background:rgba(124,134,255,.95);color:#0e1116;border:0;border-radius:6px;padding:8px 10px;font:600 13px inherit;cursor:pointer}
    button.send[disabled]{background:#2a323d;color:#8b949e;cursor:default}
    button.ghost{background:none;border:1px solid #2a323d;color:#8b949e;border-radius:6px;padding:8px 10px;font:13px inherit;cursor:pointer}
    .status{margin-top:8px;font-size:12px;color:#8b949e}
    .status.err{color:#f85149}
    .status.ok{color:#a5adff}
    .rec{background:#161b22;border:1px solid #2a323d;border-radius:6px;padding:6px 8px;margin-top:8px;font-size:12px;color:#d29922}
  `;

  // The host spans the viewport so rings can be drawn anywhere in it, which
  // means it MUST stay pointer-events:none — with 'auto' it swallowed every
  // click before the page ever saw one, so nothing could be selected and the
  // recorder logged a click on the overlay itself. Only .panel takes events.
  // Measured: two clicks meant for #lens and #body both landed on
  // #rewalk-comment and the selection list stayed empty.
  const lens = L.create({ id: ROOT_ID, isolateKeys: true, extraCss: PANEL_CSS });

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
  /** Why there is no list, when there is no list. Not the same as "none live". */
  let listError = '';

  const mk = (tag, css, text) => {
    const el = document.createElement(tag);
    if (css) el.style.cssText = css;
    if (text != null) el.textContent = text;
    return el;
  };

  // --- the fiber walk, which lives in the other world ------------------------
  // The component chain is computed by tick.js in the MAIN world; the ISOLATED
  // world cannot reach window.__rewalkReact. Comments used to simply ship
  // `react: null`, so the overlay showed a component name in its chip that the
  // envelope then threw away, and the agent got a bare selector it could have
  // produced itself with devtools.
  //
  // Ask over the DOM, the only channel the two worlds share. The question is
  // dispatched ON the element (so the responder can read e.target) and the
  // answer comes back as a JSON string on document; both dispatches are
  // synchronous, so this returns before the outer call does. No page node is
  // mutated — a custom event type nobody listens for leaves no trace in the
  // recording.
  function reactChain(el) {
    if (!el) return null;
    let answer = null;
    const token = myKey();
    const onA = (e) => {
      try { const d = JSON.parse(e.detail); if (d.token === token) answer = d.react; } catch (x) {}
    };
    document.addEventListener('__rewalk_react_a', onA);
    try { el.dispatchEvent(new CustomEvent('__rewalk_react_q', { detail: token, bubbles: true })); } catch (e) {}
    document.removeEventListener('__rewalk_react_a', onA);
    return answer;
  }

  // --- painting -------------------------------------------------------------
  // Rings are drawn INSIDE the lens's shadow root over each element's rect,
  // never on the page's own nodes: setting style.outline on an app node would
  // be an attribute mutation, which is exactly what the resolver reads.
  function paint() {
    if (!shade) return;
    lens.pin(picked.map((p) => ({ el: p.el, text: p.s })));
    for (const el of [...shade.querySelectorAll('.panel')]) el.remove();
    if (isTop) lens.clampPanel(shade.appendChild(panel()), recording ? 62 : 16);
  }

  /** What a picked element becomes on the wire. */
  const describe = (p) => ({
    key: p.key,
    s: p.s,
    at: p.at,
    text: (p.el.textContent || '').trim().slice(0, 120),
    snippet: (p.el.outerHTML || '').slice(0, 400),
    ...(p.react ? { react: p.react } : { react: null }),
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
        row.appendChild(mk('span', '', n.react?.chain?.[0] ? `${n.react.chain[0]}  ${n.s}` : n.s));
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
      const o = mk('option', '', pending ? 'looking for agent sessions…'
        : listError || 'no agent session is running');
      o.value = '';
      picker.appendChild(o);
      picker.disabled = true;
    } else {
      for (const s of sessions) {
        // The name the hub settled on — a named pane, else what the person
        // renamed the session to, else the directory (sessionLabel in
        // lib/hub-state.mjs). One ladder, so this picker and `rewalk comment
        // --sessions` cannot call the same session two different things. Then
        // the status, because delivery is a pull — an idle session takes this
        // as soon as it is nudged, a busy one at its next tool call.
        const label = [s.label || s.pane_name || s.slug, s.agent,
          s.agent_status && s.agent_status !== 'idle' ? s.agent_status : null,
          s.discovered ? 'found' : null].filter(Boolean);
        const o = mk('option', '', label.join(' — '));
        o.value = s.session_id;
        if (target === s.session_id) o.selected = true;
        picker.appendChild(o);
      }
    }
    // Upward, every time. The choice belongs to the TAB and the service worker
    // is what owns it — this panel dies with the page, the overlay and the
    // worker, and used to take the choice with it.
    picker.onchange = () => { target = picker.value || null; tell({ rewalk: 'target', target }); };
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
  const inOverlay = (el) => L.isOurs(el);

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
    // The element a mark would have named for this same click, not the literal
    // event target: clicking the <svg> inside a close button is a comment about
    // the button.
    const el = L.pickTarget(e.target);
    if (!el) return;
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
    const p = { el, s: sel(el) || el.tagName.toLowerCase(), at: Date.now(), key: myKey(), react: reactChain(el) };
    picked.push(p);
    // A child frame has no panel to show this in; the top frame's does.
    if (!isTop) tell({ rewalk: 'pick', node: describe(p) });
    paint();
  };
  const swallow = (e) => { if (on && !inOverlay(e.target)) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); } };

  const onMove = (e) => {
    if (!on || !shade) return;
    if (inOverlay(e.target) || !e.target || e.target.nodeType !== 1) { lens.track(null); return; }
    const el = L.pickTarget(e.target);
    lens.track(el);
    if (el) {
      const chain = reactChain(el);
      lens.label(chain?.chain?.[0] ?? '', sel(el) || el.tagName.toLowerCase());
    }
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
  /**
   * Which session is selected, most specific first: the one the service worker
   * remembers for this tab, then whatever is already showing, then the hub's
   * own order — sessions[0] is most recently active, and is the right cold
   * start for a tab nobody has commented from yet.
   *
   * Every candidate is checked against the live list before it is used. A
   * remembered session that has since exited must fall THROUGH: the hub will
   * not route to a dead one, so keeping it selected produces a comment that
   * sits queued for ever while looking exactly like a comment that was sent.
   *
   * Before the list arrives there is nothing to check against, so the
   * remembered id is held as-is rather than thrown away.
   * @param {string | null | undefined} want
   */
  function chooseTarget(want) {
    if (!sessions.length) return want ?? target ?? null;
    const live = (id) => (id ? sessions.find((s) => s.session_id === id)?.session_id ?? null : null);
    return live(want) ?? live(target) ?? sessions[0]?.session_id ?? null;
  }

  function setSessions(list, chosen, error) {
    sessions = list ?? [];
    pending = false;
    listError = sessions.length ? '' : (error || '');
    // A failure to ASK is worth saying out loud, not just leaving as an empty
    // picker. Without this the only symptom of a missing native host or a hub
    // that has not come up yet is a comment that cannot be sent anywhere, and
    // nothing on screen explaining why.
    if (listError) status = { text: listError, kind: 'err' };
    target = chooseTarget(chosen);
    if (on) paint();
  }

  function open(state) {
    recording = state?.recording ?? null;
    pending = !!state?.pending;
    listError = '';
    sessions = state?.sessions ?? [];
    target = chooseTarget(state?.target);
    status = '';
    on = true;
    shade = lens.ensure();
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
    lens.teardown();
    shade = null;
  }

  // The panel is unobservable by construction: a closed shadow root, inside the
  // ISOLATED world, which the page cannot reach and Playwright has no API for.
  // Everything below is how the extension's own code — a console, or
  // bin/ext-check.mjs through chrome.scripting.executeScript — asks what it is
  // showing. `session` is the comment's chosen target; lens.probe()'s `target`
  // is the RING's element, a different question with an unfortunately similar
  // name. `root` hands back the closed root itself so a check can drive the
  // real <select>; nothing on the page can see this object.
  window.__rewalkAnnotate = {
    open,
    close,
    toggle: (state) => (on ? close() : open(state)),
    root: () => shade,
    probe: () => ({
      open: on,
      ...lens.probe(),
      session: target,
      listError,
      picked: picked.length + remote.length,
      options: [...(shade ? shade.querySelectorAll('select option') : [])]
        .map((o) => ({ value: o.value, text: o.textContent, selected: o.selected })),
    }),
  };
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
      case 'sessions': setSessions(msg.sessions, msg.target, msg.error); reply({ ok: true }); break;
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
