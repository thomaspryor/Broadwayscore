---
name: SERP unavailable must be a sentinel, not null
description: Loops calling searchForReviewViaSERP need to distinguish "no results" from "providers down" — otherwise one outage burns full budget
type: feedback
originSessionId: f29fae96-61f0-4278-a50c-f6b0b78d8c24
archived: true
---
SERP helpers that iterate across many calls (per-outlet or per-critic loops) must return a distinct sentinel when both providers are unavailable, not collapse to `null`. Otherwise one BD/SB outage walks the entire budget + DELAY_MS sleeps for a run that will fail identically at every step.

**Why:** Ship-check 2026-04-22 found that `searchForReviewViaSERP` was returning `null` both on "no results" and on `__SERP_UNAVAILABLE__`. The new multi-critic per-critic loop would iterate all 6 NYSR critics + outlet fallback + every remaining allowlist outlet when SERP was down — 100+ wasted calls per show × ~3s sleep each. Fixed in commit 9dcdae8437: `searchForReviewViaSERP` now returns `{ unavailable: true }` and the outer loop sets `serpUnavailable = true` to abort.

**How to apply:** Any new scraper/SERP helper that wraps a provider chain must:
1. Return a distinct unavailable sentinel (e.g. `{ unavailable: true }`) that callers can detect.
2. Callers in a loop must short-circuit on unavailable — don't rely on "null means no hit" to handle outages.
3. Add a wiring test that greps for both the sentinel return shape and the caller's break.

Applies to: scripts/lib/scraper.js, scripts/lib/url-discovery.js, and any script wrapping fetchPage() that loops.
