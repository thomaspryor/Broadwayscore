---
name: feedback_push_retry_widening_ineffective_under_churn
description: "Widening push-with-retry.sh's retry budget does not help land non-critical commits when main is churning fast — use a non-blocking fallback instead"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 0031859b-890a-4845-b711-edbb4ddabb72
  modified: 2026-07-24T01:38:28.412Z
---

Under heavy main-branch commit churn, widening `push-with-retry.sh`'s budget (more retries / longer `PUSH_DEADLINE_SEC`) does not improve the odds of a low-priority periodic commit landing — it can lose every attempt regardless of budget size, while burning real CI minutes on an unwinnable race. The correct fix for a non-critical, periodic commit (snapshot updates, audit-data refreshes) is a non-blocking `|| echo "::warning::..."` fallback on the push step: a lost race must not redden the job, since the commit isn't time-sensitive and the next scheduled/dispatched run recomputes the same diff.

**Why:** Task #353 (2026-07-24) live-reproduced this twice. First, `check-seo-health.yml`'s "Push audit data" step lost 3/3 attempts on the default budget. Widening to 20 retries / 900s (`PUSH_DEADLINE_SEC`) was tried next — it then lost 9/9 attempts over 16 straight minutes, proving the remote tip was advancing roughly every ~90-100s continuously, faster than even a generous retry cycle. The same wrong first instinct (assume a shallow-clone/`fetch-depth` correctness bug) also cost real diagnosis time before live logs showed it was a moving-target race, not a git-history-correctness issue — see [[feedback_worktree_code_changes.md]] and `opening-night-poller.yml`'s own `fetch-depth: 0` comment (a *different* incident, task #209, that this one superficially resembled but wasn't).

**How to apply:** Before touching `PUSH_DEADLINE_SEC` or retry counts on any `push-with-retry.sh` call site, check whether the commit is genuinely non-critical/periodic. If so, skip the budget tuning and add the non-blocking fallback directly. Reserve retry-budget tuning for calls where landing the commit is load-bearing for a downstream step in the SAME run (rare) — even then, verify empirically with `gh run view --log` before assuming a bigger number helps; this repo's commit velocity can defeat multi-minute retry budgets outright. If a future task genuinely needs guaranteed landing under this churn, the real fix is a non-git atomic path (e.g. GitHub Contents API PUT with SHA-based optimistic concurrency, retried cheaply per-file) — not a bigger git-based retry loop.
