---
name: Live-fire gather-reviews — pick shows with 0 SS-sourced reviews
description: gather-reviews.js SS verification phase times out 30s × N on old outlet URLs; pick a target show with 0 SS-sourced files to skip it
type: feedback
originSessionId: f29fae96-61f0-4278-a50c-f6b0b78d8c24
archived: true
---
When live-firing `scripts/gather-reviews.js --shows=<id>` to verify code paths (per-critic SERP loop, partial-extraction fallback, etc.), the Show Score verification phase can burn 20–40 minutes on a show with many SS-sourced reviews — each outlet URL hits a 30s Playwright timeout via the BD/SB/cookie-plain/Playwright fallback chain.

**Why:** On 2026-04-22 a test run against `les-liaisons-dangereuses-west-end-2026` (49 SS-sourced reviews) was still in SS verification after 10+ minutes with no progress toward the SERP loop we wanted to observe. Switched to `avenue-q-west-end-2026` (0 SS-sourced reviews) and the SERP loop ran in ~2 minutes.

**How to apply:** Before picking a live-fire target, run:

```
grep -lE "\"source\":\s*\"show-score" data/review-texts/<show-id>/*.json | wc -l
```

Prefer shows with 0–5 SS-sourced files. Recently-opened 2026 shows that haven't been fully crawled are ideal. Avoid shows with large archival SS footprints (100+ reviews, often 2010s revivals).

Applies to any ad-hoc run of gather-reviews.js intended to observe specific code paths within a normal timebox.
