---
name: URL state — preserve unknown params when multiple writers exist
description: When two code paths both write the URL (inline updateParams + new feature's router.replace), the one with a hard-coded allowlist silently wipes the other's params. Caught in PR #283 ship-check.
type: feedback
originSessionId: c013fa2d-00bf-4653-a707-51d9f50b64c7
archived: true
---
When adding a new feature that uses URL params alongside an existing URL-writing function, the old function MUST preserve unknown params or the new feature's state vanishes silently on the next user action.

**Why:** Hit this in the filter-panel PR #283 (2026-04-26). The 4 page clients each had `updateParams(...)` that built a fresh `URLSearchParams()` from a hard-coded allowlist (`status/sort/type/scoreMode/q`). The new `usePanelFilters` hook wrote `?awards=...&production=...` via `router.replace`. The moment the user toggled CLOSING or typed in search, all panel params got wiped. The bug was invisible during single-feature testing — both halves worked alone — and only surfaced when a QA reviewer simulated mixed inline + panel use.

**How to apply:**
- When adding a new URL-managed feature, audit *every* existing function that writes the URL on the same page and confirm it preserves unknown params.
- Idiom: `const params = new URLSearchParams(window.location.search); /* mutate only known keys */`. Never rebuild from scratch.
- Bug-finding test: apply panel/new-feature filter → toggle inline filter → check URL still has both. Single-feature tests miss this.

**Related:** `feedback_react_searchparams_stale.md` — the inverse pattern, where reading from React's `useSearchParams()` lags `router.replace` by one render. For rapid back-to-back writes, read `window.location.search` live.
