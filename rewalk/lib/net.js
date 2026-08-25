// Injected next to rrweb. The request/response ledger: what the page asked the
// network and what came back, in the same stream as everything else.
//
// "I click the button and nothing happens" is invisible in a DOM diff — the
// whole point of the complaint is that no pixel changed. What DID happen is a
// request that failed, hung, or never fired, and an exception that killed the
// handler. So: wrap fetch and XMLHttpRequest (status, duration, and for FAILED
// responses a capped slice of the body — what the server said), and forward
// page errors, unhandled rejections and console.error/warn.
//
// Deliberately NOT here: response bodies of successful requests (size and
// privacy for no diagnostic value) and document navigations/downloads (not
// observable from page JS; a chrome.debugger route could see them, unbuilt).
// A1's ablation validated this capture layer; shipping it as session data is
// the user's call, recorded in notes/ablation-plan.md.
(() => {
  if (window.__rewalkNet || location.href === 'about:blank') return;
  window.__rewalkNet = 1;
  const emit = (type, data) => {
    try { window.rrweb?.record?.addCustomEvent?.(type, data); } catch (e) {}
  };
  const BODY_CAP = 2048;
  const net = (kind, method, url, status, ms, extra) =>
    emit('rewalk-net', { kind, method: String(method || 'GET').toUpperCase(),
      url: String(url).slice(0, 500), status, ms: Math.round(ms), ...extra });

  // What the server said, for failures only, text-ish bodies only, capped.
  const failBody = (res) => res.clone().text()
    .then((t) => (/json|text|xml/.test(res.headers.get('content-type') || '') ? t.slice(0, BODY_CAP) : undefined))
    .catch(() => undefined);

  const F = window.fetch;
  if (F) window.fetch = function (input, init) {
    const t0 = performance.now();
    const method = (init && init.method) || (input && input.method) || 'GET';
    const url = (input && input.url) || String(input);
    return F.apply(this, arguments).then((res) => {
      const ms = performance.now() - t0;
      if (res.ok) net('fetch', method, url, res.status, ms);
      else failBody(res).then((body) => net('fetch', method, url, res.status, ms, body != null ? { body } : {}));
      return res;
    }, (err) => {
      net('fetch', method, url, 0, performance.now() - t0,
        { error: String((err && err.message) || err).slice(0, 200) });
      throw err;
    });
  };

  const XO = XMLHttpRequest.prototype.open, XS = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__rewalkReq = { method, url };
    return XO.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    const m = this.__rewalkReq || {}, t0 = performance.now();
    this.addEventListener('loadend', () => {
      const extra = {};
      if (this.status === 0) extra.error = 'network error or aborted';
      else if (this.status >= 400) {
        try {
          if (/json|text|xml/.test(this.getResponseHeader('content-type') || '') && typeof this.responseText === 'string')
            extra.body = this.responseText.slice(0, BODY_CAP);
        } catch (e) {}
      }
      net('xhr', m.method, m.url || '?', this.status, performance.now() - t0, extra);
    });
    return XS.apply(this, arguments);
  };

  // The other half of "nothing happened": the exception that killed the handler.
  const say = (level, text, src) =>
    emit('rewalk-console', { level, text: String(text).slice(0, 300), ...(src ? { src } : {}) });
  addEventListener('error', (e) => {
    if (e instanceof ErrorEvent && e.message)
      say('error', e.message, e.filename ? `${e.filename.split('/').pop()}:${e.lineno}` : undefined);
  }, true);
  addEventListener('unhandledrejection', (e) => {
    let t = ''; try { t = String((e.reason && e.reason.message) || e.reason); } catch (x) {}
    say('unhandledrejection', t);
  });
  for (const level of ['error', 'warn']) {
    const orig = console[level];
    console[level] = function () {
      try {
        say(level, Array.prototype.map.call(arguments, (x) => {
          if (typeof x === 'string') return x;
          try { return JSON.stringify(x); } catch (e) { return String(x); }
        }).join(' '));
      } catch (e) {}
      return orig.apply(this, arguments);
    };
  }
})();
