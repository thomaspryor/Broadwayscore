---
name: feedback_second_opinion_diff_cap
description: /second-opinion only satisfies the merge/push review gate for diffs <=100 gated lines; bigger diffs need /code-review or /ship-check
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 201ce0a6-23f5-45c3-942b-966109135df4
  modified: 2026-08-12T18:55:24.058Z
---

Recording a `/second-opinion` pass verdict via `review-gate.mjs --query=record` does NOT satisfy the merge/push review gate for diffs over 100 gated lines. The gate picks the nearest ELIGIBLE verdict for the diff size, so a second-opinion verdict on a 300+ line diff is silently skipped in favor of an older (possibly stale, >150-line-drift) verdict from a heavier reviewer — the merge then blocks citing that stale verdict, not the fresh second-opinion one, which is confusing until you check the ledger.

**Why:** discovered on task #1316 (merge-gate hook e2e test, 399 gated lines) — ran `/second-opinion`, recorded a pass, then `merge-worktree-to-main.sh` blocked anyway citing a *different*, older `code-review` verdict as the "nearest" one. The `/second-opinion` skill's own instructions state the 100-line cap explicitly (easy to miss mid-task).

**How to apply:** before choosing a review skill for a diff about to be merged/pushed, check the gated line count first (`node scripts/lib/review-gate.mjs --query=diff-hash --repo=. --ref=<branch>` or just estimate from `git diff --stat`). ≤100 gated lines → `/second-opinion` is fine. >100 → use `/code-review` or `/ship-check` instead, or the merge will block on a stale verdict with a confusing error.
