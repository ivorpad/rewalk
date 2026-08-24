// Ordering probe. If this evaluates before the page's first inline script,
// the fixture sees __probeAt and the attachShadow marker; if not, the whole
// extension route inherits a race the Playwright addInitScript route does not
// have. Runs in every frame so the iframe case is measured, not assumed.
import type { PlasmoCSConfig } from "plasmo"

export const config: PlasmoCSConfig = {
  matches: ["http://127.0.0.1/*", "http://localhost/*"],
  run_at: "document_start",
  world: "MAIN",
  all_frames: true
}

;(() => {
  const w = window as any
  w.__probeAt = {
    t: performance.now(),
    readyState: document.readyState,
    href: location.href
  }
  const orig = Element.prototype.attachShadow
  const patched = function (this: Element, init: ShadowRootInit): ShadowRoot {
    return orig.call(this, init)
  }
  ;(patched as any).__rewalkPatched = true
  Element.prototype.attachShadow = patched as typeof Element.prototype.attachShadow
})()
