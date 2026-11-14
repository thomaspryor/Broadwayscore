---
name: if-always-cleanup-budget
description: "GHA `if: always()` DOES run on cancel, but inside a ~5min cleanup window — long commit/push retries inside that window can SIGTERM before subsequent steps run"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 11806073-b437-437e-8e7a-78130264abef
---

When a GHA job hits `timeout-minutes`, the runner sends SIGTERM to the in-flight step and then enters a **bounded cleanup window** (~5 min default) where `if: always()` steps can run. **Inside that window, steps run sequentially.** If the first cleanup step eats the budget, subsequent `if: always()` steps get skipped.

**Verified evidence (`scrape-westendtheatre.yml` run 25997644419):**
- 17:39:05 — scraper step `cancelled` at 15-min cap.
- 17:39:05 → 17:43:57 (4m52s) — `Commit data changes` (if: always()) **ran**, but `push-with-retry.sh` got a non-fast-forward rejection on attempt 1 and slept 40s before retry; SIGTERM hit during the wait → step ended `failure` with exit 143.
- 17:43:57 — `Push review-texts to private repo` (if: always()) — `skipped`. Cleanup budget exhausted.

So my original "`if: always()` skips on cancel" theory was wrong. The real failure mode: **the cleanup budget is small enough that any retry/backoff in the first if-always step starves the rest.**

**How to apply:**
- Don't rely on `if: always() && [secondary condition]` for "save my work on timeout" — the secondary condition (e.g., `steps.fix.outputs.changes_made == 'true'`) usually depends on the cancelled step's output, which was never set, so the commit gets skipped on its OWN condition (not the cleanup budget). Either: (a) make the secondary condition more permissive, or (b) bump `timeout-minutes` so cancellation never happens.
- Don't chain `push-with-retry.sh` (which sleeps tens of seconds between attempts) inside a single if-always step before another if-always step that needs to run. The retry loop will eat the cleanup window.
- The simplest robust fix is **raising the timeout so the cancellation path never trips** — confirmed-working on WET (15→30 min, run 26365154789 committed 179 files cleanly) and `fix-todaytix-links.yml` (15→30 min, was hitting the cap on its last green run at 13m38s).

**Detection grep:**
- Workflows with `timeout-minutes` + `if: always()` on commit/push steps + history of cancellation:
  `for f in .github/workflows/*.yml; do grep -q "timeout-minutes:" "$f" && grep -q "if: always()" "$f" && echo "$f"; done` (117 in this repo). Then check each with `gh run list --workflow=NAME --status cancelled --limit 30`.

**Audit done 2026-05-24:** the actual WET-pattern siblings in this repo were `fix-todaytix-links.yml` (8 consecutive weekly cancels since 2026-04-06) and `recover-explicit-ratings.yml` (multiple cancels, partial data lands). See Notion `36a637c5-416f-8103-af34-c092b16e4801`.
