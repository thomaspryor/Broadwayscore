---
name: feedback_ugc_test_patterns
description: Common failure patterns in Test UGC Features CI workflow and their fixes
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 460f995b-5819-47d6-a3ec-7e9689783aa9
---

UGC test failures come in 4 categories:

1. **Sanity build env** — `NEXT_PUBLIC_SANITY_DATASET` and `NEXT_PUBLIC_SANITY_PROJECT_ID` must be in the build step's `env:` block in `test-ugc.yml`. Vercel injects these automatically but `npx next build` does not. Both are non-sensitive (NEXT_PUBLIC_*), hardcode in workflow.

2. **Stale mock dates** — `src/app/my-shows/__dev-mock-data.ts` has hardcoded `planned_date` values for "Upcoming" watchlist items. When those dates pass (w1 Gypsy, w2 Smash), they move to "To Be Rated" section and all Upcoming/Past-Shows tests fail. Fix: bump dates to ~6+ months out; also update `my-shows-mock.spec.ts` date text assertions.

3. **Mobile tab bar overflow** — The tab bar (Diary/Watchlist/Lists + sort + view toggle) overflows the 390px mobile viewport. Current fix: `px-2 sm:px-4` on all 3 tab buttons and `max-w-[80px] sm:max-w-none` on sort selects. The content area is 358px (390-2×16px padding); tab bar total must stay under that.

4. **Rating card date count** — `ShowPageRating.tsx` shows the latest review's date in the main row AND 3 previous viewing dates. Mobile test must count dates within `[data-testid="previous-viewings"]` (expect 3), NOT within all of `[data-testid="rating-card"]` (would find 4).

5. **Visual baselines stale** — After any UI change, trigger workflow with `update_snapshots=true` to regenerate. The workflow has concurrency `cancel-in-progress: true`, so push-triggered runs cancel manual dispatch — wait for push run to finish first, then trigger snapshot update if needed.

6. **Console 404 URLs** — Updated test to capture `page.on('response', ...)` for 404s with their URLs. The prior "Failed to load resource" console message had no URL. Still investigating what 404s in CI.

**Why:** These failures accumulated because the test-ugc.yml workflow was broken (rate limit + Sanity env) for weeks, so tests never ran in CI.
