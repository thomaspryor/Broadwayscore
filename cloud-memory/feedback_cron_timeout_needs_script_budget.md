---
name: feedback-cron-timeout-needs-script-budget
description: "Weekly cron \"cancelled\" runs = timeout-minutes SIGKILL; fix with script-level wall-clock budget + rotation, and check persistence wiring before capping"
metadata: 
  node_type: memory
  type: project
  originSessionId: 985590dc-02e3-46bd-ae6e-7c970acd93f3
---

A scheduled workflow run with conclusion `cancelled` (and job duration ≈ timeout-minutes) is a timeout kill, not a concurrency cancel. Seen 2026-06-11: recover-explicit-ratings (5/6 weeks), commercial-weekly deep-research (3 weeks), scrape-westendtheatre.

**Why:** Raising timeout-minutes masks backlog growth; SIGKILL mid-item loses the tail forever because deterministic ordering re-runs the same head weekly.

**How to apply:**
- Give the script `--time-budget-min` via `scripts/lib/run-budget.js` (`parseTimeBudgetMin` + `createRunBudget`); workflow passes budget ≈ timeout − 20%, timeout becomes a backstop. Log a deferred-count message so degradation stays visible.
- Add rotation state (least-recently-attempted first) or the same head starves the tail — and record attempts in EVERY phase loop, not just the expensive ones.
- BEFORE capping, check the workflow actually persists its skip-cache: scrape-westendtheatre's real root cause was a missing `checkout-aggregator-archive`/`push-aggregator-archive` pair (~19 sibling workflows had it; this one didn't), so its archive skip never fired in CI.
- Negative caches must only record *successful* fetches that found nothing — caching fetch failures turns one WAF outage into a 45-day blind spot.
- GHA gotcha: `${{ inputs.x || '100' }}` coerces a literal `0` to falsy; default in bash instead ([[feedback_gha_secrets_in_if.md]] for related expression limits).
