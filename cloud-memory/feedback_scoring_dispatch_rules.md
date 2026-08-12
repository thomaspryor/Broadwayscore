---
name: Scoring dispatch rules
description: Two rules for dispatching ensemble-score workflow — commit review-texts first, use unique rescore_reason for parallel runs
type: feedback
originSessionId: 1af22278-23f7-4d3e-9141-2e93479a729c
---
1. **Commit+push review-texts BEFORE dispatching scoring.** CI checks out review-texts from GitHub, not local disk. If you modify files locally (strip wrongProduction, move files) but don't push, the scoring workflow sees the old version and skips them.

**Why:** Backlog migration 2026-04-12 moved 111 files locally but never pushed review-texts. First 20 scoring dispatches scored 0 of the migrated files because CI checked out the pre-migration state.

**How to apply:** Any time you modify review-texts files and want them scored: `cd data/review-texts && git add -A && git commit -m "..." && git push origin main` BEFORE `gh workflow run 226562746`.

2. **Use unique `rescore_reason` per show for parallel scoring dispatch.** The concurrency group is `scoring-reviews{-reason}`. Without a reason, all runs share one group — only 1 runs + 1 queues, the rest get cancelled immediately. With unique reasons, each gets its own group and they run in parallel.

**Why:** 20 dispatches without rescore_reason → 19 cancelled. 20 dispatches with `-f rescore_reason="backlog-$show"` → all 20 ran in parallel.

**How to apply:** `gh workflow run 226562746 -f show="$show" -f rescore_reason="batch-$show"`. Use any unique string per run.
