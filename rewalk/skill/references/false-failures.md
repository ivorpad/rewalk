# False failures

A harness that cries wolf is worse than no harness, because the report stops
being read. Every entry below was observed in a real run, not imagined.

| symptom | real cause | fix |
|---|---|---|
| assertion fails ~0ms after a click | one-shot read racing an async redirect (server actions and client routers navigate without a navigation event) | assertions retry to a deadline |
| every non-auth flow fails on the login page | a fresh browser context per flow, so no session | authenticate once, reuse `storageState` |
| timeout on an element you can plainly see | `.first()` bound to a hidden twin (a collapsed nav, a mobile duplicate, a sign-out form rendered above the real one) | strict locators; scope with `:has()` |
| field looks filled, form rejects it | `pressSequentially` into `<input type=date\|number>`; segmented inputs need an ISO value | `fill()` for those types, then read the value back |
| step reports pass but nothing was entered | the value was never verified after writing | compare `inputValue()` to the intended value, fail on mismatch |
| assertion passes on the wrong page | substring URL matching (`/orders/new` contains `/orders`) | `=` prefix for exact, `!` for must-not-contain |
| whole suite fails, code unchanged | leftover browser processes exhausting memory; renderer OOM presents as `Target crashed` | kill strays before a run |
| a run passes against a 404 | another process owns the port | ground-truth check before step 1 |
| green locally, flaky in CI | timeout too close to real assertion latency | set it from measured latency, not taste |

## The rule that matters

**Every failure is a harness bug until a standalone probe reproduces it.**

Write a throwaway script that does the smallest thing that should work, run it
outside the harness, and only then call it an app bug. In the run this skill
was built from, the first pass produced 20 failures. 18 were harness bugs. 2
were real. Filing the other 18 would have burned a day of someone's week.

If `prove-it` is installed, its §2 is the longer form of this.

## rrweb specifics

- `rrweb.record()` on `about:blank` crashes the renderer. Guard on `location.href`.
- The UMD bundle ends in `}))` with no semicolon; concatenating a starter script
  without `;` makes the next IIFE parse as a call on it.
- Batch `emit` in-page and flush on an interval. One binding call per event
  will crash the tab.
- Replays embed the **real DOM**, including whatever data was on screen. Set
  `mask: true` before one leaves the machine.
