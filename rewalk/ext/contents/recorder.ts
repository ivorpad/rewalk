// The real rrweb bundle (the exact file lib/record.mjs injects, copied to
// lib/rrweb.umd.min.js) plus the minimal boot from bootScript()'s `rec`
// section, with the emit going to a window buffer instead of __rewalkEmit.
// maskAllInputs is off here so the JS-set input value is visible in the
// captured events; production keeps it on.
import type { PlasmoCSConfig } from "plasmo"

// UMD under Parcel takes the CommonJS branch, so this import IS the rrweb
// namespace; window.rrweb is assigned below to mirror the production bundle.
import * as rrweb from "~lib/rrweb.umd.min.js"

export const config: PlasmoCSConfig = {
  matches: ["http://127.0.0.1/*", "http://localhost/*"],
  run_at: "document_start",
  world: "MAIN",
  all_frames: true
}

;(() => {
  const w = window as any
  if (w.__rr || location.href === "about:blank") return
  w.__rr = 1
  w.rrweb = rrweb
  w.__rrExtBuf = []
  w.__rrBootAt = { t: performance.now(), readyState: document.readyState }
  const go = () => {
    rrweb.record({
      emit: (e: unknown) => w.__rrExtBuf.push(e),
      inlineStylesheet: true,
      collectFonts: false,
      maskAllInputs: false,
      sampling: { mousemove: 20, scroll: 120, input: "last" }
    })
    w.__rrRecordAt = { t: performance.now(), readyState: document.readyState }
  }
  document.readyState === "loading"
    ? addEventListener("DOMContentLoaded", go)
    : go()
})()
