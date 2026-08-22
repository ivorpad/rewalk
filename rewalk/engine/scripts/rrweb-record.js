(() => {
  if (window.__rr || location.href === 'about:blank') return;   // recording about:blank crashes the renderer
  window.__rr = 1;
  const buf = [];
  // QA steps become first-class rrweb events (Sentry does this for breadcrumbs).
  // Also keeps the timeline spanning idle waits, which record no mutations.
  window.__qaStep = p => { try { rrweb.record.addCustomEvent('qa-step', p); } catch (e) {} };
  window.__rrFlush = () => { if (buf.length) window.__rrwebEmit(buf.splice(0, buf.length)); };
  const go = () => {
    rrweb.record({
      emit: e => buf.push(e),
      inlineStylesheet: true,        // so the replay works with the app switched off
      collectFonts: false,
      recordCanvas: false,
      maskAllInputs: __MASK__,       // replays embed the real DOM; mask before sharing
      maskTextSelector: __MASK__ ? '[data-qa-mask]' : undefined,
      sampling: { mousemove: 20, scroll: 120, input: 'last' },
    });
    setInterval(window.__rrFlush, 250);
    addEventListener('pagehide', window.__rrFlush, true);
  };
  document.readyState === 'loading' ? addEventListener('DOMContentLoaded', go) : go();
})();
