// How an element gets named. One implementation, evaluated in every world that
// needs it.
//
// This was inside tick.js, which runs in the page's MAIN world. The comment
// overlay runs in the ISOLATED world and has to name the same elements: a
// comment whose selector disagrees with the mark recorded for the same click
// would send an agent to a different node than the one the person pointed at.
// Separate worlds cannot share an object, so they share this source text and
// each evaluates its own copy.
//
// The rule: an id if it is unique, otherwise a readable path. A selector
// nobody can read is a selector nobody will trust.
(() => {
  if (window.__rewalkSelector || location.href === 'about:blank') return;

  // el.id is NOT safe on a form: named controls shadow the property, so a
  // <form> containing <input name="id"> returns that INPUT ELEMENT from
  // form.id, and CSS.escape stringifies it to "[object HTMLInputElement]".
  // Measured on a real app (ledger): five unrelated forms each carried a
  // hidden id field, every one collapsed to the identical bogus selector, and
  // the ranking merged five distinct nodes into one. getAttribute cannot be
  // shadowed. The same trap exists for name, action, and anything else a
  // control can be named after.
  const idOf = (el) => {
    const v = el.getAttribute && el.getAttribute('id');
    return typeof v === 'string' && v ? v : null;
  };

  window.__rewalkSelector = (el) => {
    if (!el || el.nodeType !== 1) return null;
    if (idOf(el)) return '#' + CSS.escape(idOf(el));
    const label = el.getAttribute('aria-label');
    if (label && document.querySelectorAll(`[aria-label="${CSS.escape(label)}"]`).length === 1)
      return `[aria-label="${label}"]`;
    const testid = el.getAttribute('data-testid');
    if (testid && document.querySelectorAll(`[data-testid="${CSS.escape(testid)}"]`).length === 1)
      return `[data-testid="${testid}"]`;
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1 && parts.length < 5) {
      let p = n.tagName.toLowerCase();
      if (idOf(n)) { parts.unshift('#' + CSS.escape(idOf(n))); break; }
      const alabel = n.getAttribute('aria-label');
      if (alabel && document.querySelectorAll(`[aria-label="${CSS.escape(alabel)}"]`).length === 1) {
        parts.unshift(`[aria-label="${alabel}"]`); break;
      }
      const dl = n.getAttribute('data-line');
      if (dl) p += `[data-line="${dl}"]`;
      else {
        const cls = [...n.classList].filter((c) => c.length < 24 && !/[0-9]{3,}|^css-|^sc-/.test(c)).slice(0, 2);
        if (cls.length) p += cls.map((c) => '.' + CSS.escape(c)).join('');
      }
      parts.unshift(p);
      try { if (document.querySelectorAll(parts.join(' > ')).length === 1) break; } catch (e) {}
      n = n.parentElement;
    }
    return parts.join(' > ');
  };
})();
