---
name: useSearchParams() lags router.replace by one render
description: For rapid back-to-back URL writes (e.g. tap-tap on multi-select pills), reading from React's useSearchParams() drops the first update. Read window.location.search live instead.
type: feedback
originSessionId: c013fa2d-00bf-4653-a707-51d9f50b64c7
archived: true
---
When writing URL params via `router.replace`, the next read from `useSearchParams()` will return the OLD value until React re-renders. Two synchronous writes back-to-back will read the same stale snapshot, and the second write overwrites the first.

**Why:** Hit this in the filter-panel PR #283 (2026-04-26) — `usePanelFilters.writeParams` was building from `searchParams?.toString()`. Rapid clicks on Production then Awards pills resulted in only the second one persisting. URL went `?awards=tony-winner` instead of `?production=revival&awards=tony-winner`.

**How to apply:**
- For multi-write flows (live-applying pills, autosave forms), read from `window.location.search` inside `writeParams`, not from `useSearchParams()`.
- For one-off writes, `useSearchParams()` is fine.
- Test pattern that exposes this: simulate two synchronous-ish toggles in a single eval (`btn1?.click(); await sleep(50); btn2?.click()` — if the URL only shows the second one's value, you have this bug).
