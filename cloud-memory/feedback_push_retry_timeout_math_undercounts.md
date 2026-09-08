---
name: feedback-push-retry-timeout-math-undercounts
description: "When tuning job timeout-minutes / PUSH_DEADLINE_SEC for a push-with-retry.sh caller, its own summary comments undercount the real worst case — verify against the actual chained-fetch code"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: e080ac18-dc9e-419f-bcdb-6b94a90826f0
  modified: 2026-09-08T08:31:59.822Z
---

`scripts/lib/push-with-retry.sh` and `scripts/lib/push-via-git-api.sh`'s own comments summarize the Git Data API fallback's per-attempt cost as "~3 * GIT_NET_TIMEOUT_SEC" (ls-remote + fetch + push). The actual code chains an explicit-refspec fetch AND a bare-form fallback fetch (`||` chain, both individually capped at `GIT_NET_TIMEOUT_SEC`, default 90s) — so one attempt can cost up to 4x the cap (~360s), not 3x (~270s). The local retry loop has the same undercount: one iteration can chain pre-push + 2 fetch attempts + post-push before the wall-clock deadline check next fires, so `PUSH_DEADLINE_SEC` bounds *between* iterations, not *within* one.

**Why:** Found while tuning `opening-night-completeness-check.yml`'s job timeout (BRO-345 what-else, 2026-09-08) after registering two of its audit files `apiFallbackSafe: true` made the fallback newly reachable and a live test dispatch got cancelled by the job's pre-existing 8-min timeout. Three successive second-opinion review rounds each caught a more pessimistic (but real, code-confirmed) worst case than the previous round's math, because each round trusted the scripts' own summary comments instead of grepping the actual retry-loop/fetch-chain code.

**How to apply:** Before setting or trusting a `timeout-minutes` / `PUSH_DEADLINE_SEC` / `PUSH_API_MAX_RETRIES` value for any step calling `push-with-retry.sh`, grep the actual chained network-call code in both scripts (not their header comments) to compute the real worst case, then add real margin (~20%+) on top. Don't stop after the first review pass matches the scripts' own documented cost model — it's known to undercount by ~33%.
