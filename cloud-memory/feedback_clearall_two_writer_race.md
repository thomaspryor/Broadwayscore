---
name: clearAll two-writer race on shared URL
description: When a single user action mixes router.replace + window.history.replaceState (in startTransition) writes to the same URL, the deferred page write can clobber router state and leave stale params behind. Single-writer per action.
type: feedback
originSessionId: a782a067-cf9f-4ebc-91c7-fc869cb16bbd
archived: true
---
When ONE user action triggers URL writes through TWO different mechanisms in the same component, expect a race. The cost of debugging is high (silent stale params after Reset; URL says one thing, UI says another).

**Why:** Caught in PR for filter panel Type/Status mirror, 2026-04-26. The hook's `clearAll` did `writeParams()` (router.replace, sync) for multi/year keys, then called the page's override `onSetSingleValueOverride()` for type/status. The override routes through the page's `updateParams` which uses `startTransition(() => setFilters(prev => { ... window.history.replaceState(...) }))`. The replaceState writes are deferred (run when React processes the transition), and they read `window.location.search` live each time. Result: 6 successive replaceState calls in dev trace, with the FINAL one re-introducing `production=original` that writeParams had supposedly deleted.

The race isn't always visible — if all writers happen to converge on the same URL, no harm. But under reset/clear-all, the writers' inputs differ (partial-state snapshots), so the deferred write can re-add a deleted param.

**How to apply:**
- For any user action that resets or bulk-modifies URL state, use ONE writer for the entire transaction. Either router.replace OR window.history.replaceState — don't mix.
- If state is split between page-owned (window.history) and panel-owned (router.replace), pick one as canonical. Cleanest: use router.replace for the unified write so useSearchParams subscribers also re-read.
- The fix that worked: each page client owns `handlePanelClearAll`, does ONE router.replace with all panel keys stripped + a setFilters to update inline state. Hook's clearAll kept for non-controlled callers only.
- Detection trick: instrument `history.replaceState` from devtools, click the action, watch the trace. If you see >2 calls and any "regression" call (a key reappearing after being deleted), it's a race.

Related memory: `feedback_url_state_multi_writer.md`, `feedback_react_searchparams_stale.md`.
