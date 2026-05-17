---
name: router.replace is async — rapid toggles need replaceState too
description: Next.js next/navigation router.replace wraps in startTransition. Within the same tick, window.location.search hasn't updated yet, so back-to-back URL writes silently overwrite each other. For rapid multi-toggle UI (filter pills, multi-select), pair replaceState (sync) + router.replace (re-renders) writing the SAME URL — the same-URL invariant avoids the two-writer race documented in feedback_clearall_two_writer_race.md.
type: feedback
originSessionId: 830710bd-a500-4887-aea3-d334a5df34d6
archived: true
---
`router.replace` from `next/navigation` schedules an async URL update via React's `startTransition`. **`window.location.search` does NOT update synchronously** — only after the transition lands. So if a user clicks two filter pills in the same tick:

```ts
// Click 1: read URL=''. Mutate to ?dates=2025-26. router.replace(...).
// Click 2: read URL=''. Same as click 1!  Mutate to ?dates=2024-25.
//          router.replace(...) — overwrites click 1 silently.
```

**Fix pattern** (verified 2026-04-27 in `usePanelFilters.ts:writeParams` after PR #295 ship-check found 3-rapid-clicks dropped to 1):

```ts
const live = typeof window !== 'undefined' ? window.location.search : '';
const params = new URLSearchParams(live);
mutate(params);
const url = qs ? `${pathname}?${qs}` : pathname;

// Sync — subsequent in-tick reads see this
window.history.replaceState(null, '', url);
// Async — Next.js useSearchParams() updates, React re-renders
router.replace(url, { scroll: false });
```

**Why:** `feedback_clearall_two_writer_race.md` warns against mixing replaceState + router.replace because deferred writes can clobber router state. That race is when the **two writers compute different URLs** (partial snapshots inside startTransition). Here both writers write the **identical URL** synchronously from the same `params.toString()` — there's nothing to clobber. The same-URL invariant is load-bearing; if a future change drives them from different sources, the race comes back.

**Detection:** in Playwright, click 3 multi-select pills in the same `evaluate()` call and assert `location.search` reflects all 3. Without the fix, only the LAST click sticks.

**Scope of impact:** the bug pre-dated PR #295 — existing awards multi-select was silently overwriting on rapid clicks too. Anything in `usePanelFilters.toggleOption` was affected. Fix repaired both surfaces.

**Where used:** `src/lib/hooks/usePanelFilters.ts:writeParams` (single chokepoint for all panel URL writes).

**How to apply:** Whenever you write the URL inside a click/key handler that the user can fire faster than React can re-render, pair `window.history.replaceState` (sync, makes window.location.search authoritative) with `router.replace` (async, refreshes useSearchParams). Always compute the URL once and pass the same string to both. Don't add a third writer.
