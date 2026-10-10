---
name: Playwright process hang — investigated, not reproducible
description: "Hangs after DONE; browser not closed on success. timeout-minutes:30."
type: feedback
archived: true
---

A hang was reported where gather-reviews/opening-night-poller wouldn't exit after completing, blocking CI push steps.

**Investigation (2026-04-02):**
- All `browser.close()` paths in `scrapeShowScoreWithPlaywright` are correct (6 exit paths verified)
- `require('playwright')` does NOT keep the Node event loop alive (tested: exits in 0.2s)
- `browser.launch()` + `browser.close()` does NOT leave handles (exits in 1.1s)
- `gather-reviews.js` already had `process.exit(0)` on its CLI entry point
- The poller workflow already had `timeout 600 ... || true` safety net
- Recent CI runs all succeeding — no evidence of active hangs

**What was done:** Added `process.exit(0)` to `opening-night-poller.js` and `opening-night-status.js` success paths as defensive practice (matching gather-reviews.js pattern).

**How to apply:** If the hang recurs, look for:
1. Network stalls in `page.goto({ waitUntil: 'networkidle' })` exceeding its 30s timeout
2. CI resource exhaustion causing Chromium launch to hang
3. The `Promise.race` carousel timeout (30s) leaving orphaned page operations running after `browser.close()`
4. Check the specific CI run logs — the issue may be intermittent/environmental, not a code bug
