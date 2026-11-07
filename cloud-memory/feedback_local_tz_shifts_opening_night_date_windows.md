---
name: feedback-local-tz-shifts-opening-night-date-windows
description: "Local manual verification of opening-night date-window logic (selectOpeningNightShows and its callers) is flaky on this Mac's America/New_York TZ — pin TZ=UTC to match production"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 5a6addcd-6d05-497c-8651-99dfcd568c9d
  modified: 2026-08-12T17:58:30.115Z
---

`scripts/lib/opening-night-selection.js`'s `selectOpeningNightShows` (and everything built on it — `countShowsInOpeningWindow`, the BD budget reservation in `scripts/lib/opening-night-budget.js`, `check-bd-breaker.js`, `check-sd-breaker.js`, the orchestrator) parses date-only `openingDate` strings as UTC midnight (ECMA-262 default) but computes its `cutoff`/day-boundary via **local** `Date` methods (`setDate`/`setHours`). In any negative-UTC-offset timezone (this Mac's default, America/New_York, UTC-4/-5) that mismatch silently shifts the effective "today" boundary back by up to a full day — a show whose `openingDate` is genuinely "yesterday" can be excluded from a `lookbackDays: 1` window.

**Why:** discovered live during task #1315 (opening-window BD budget reservation) — running the fix locally on this Mac, Death Note (`openingDate: "2026-08-11"`, checked "today" 2026-08-12, the exact today-1 boundary the fix targets) was silently excluded from the reservation window, even though the fix was correct. Re-running the identical command with `TZ=UTC` (matching how `ubuntu-latest` GitHub Actions runners — the actual production environment for `check-bd-breaker.js` and the orchestrator — execute) included it correctly. Production is unaffected; only local verification on a non-UTC machine is.

**How to apply:** when manually verifying ANY script that calls `selectOpeningNightShows`/`countShowsInOpeningWindow` (or writing a unit test with a fixture `now`/`openingDate` near a day boundary), prefix the command with `TZ=UTC` (e.g. `TZ=UTC node scripts/check-bd-breaker.js --dry-run`) or set `process.env.TZ = 'UTC'` at the top of the test file before any `Date` use. Don't "fix" the discrepancy by fudging `lookbackDays`/`lookAheadHours` — that just relabels the bug. A genuine fix to the local/UTC mixing in `opening-night-selection.js` itself would be a separate, careful change (it's a live orchestrator-critical predicate) — not something to bundle into an unrelated task.
