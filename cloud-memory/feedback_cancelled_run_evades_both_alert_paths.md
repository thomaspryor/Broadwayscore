---
name: feedback_cancelled_run_evades_both_alert_paths
description: "A cancelled daily cron run evades notify-failure AND check-cron-health's success-window; monitor digest/alert carriers with a sub-next-cycle max_hours"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 75398ad8-1dd1-4eaa-99f4-9e878ba103c9
---

A *cancelled* GitHub Actions run (conclusion=cancelled, from concurrency cancel-in-progress, timeout, or manual) is invisible to BOTH alert paths: `notify-failure`'s `if: failure()` ignores it, AND `check-cron-health.yml`'s success-keyed recency tolerates it — because for a *daily* cron, the next day's success resets the rolling window before the next noon check, so a single cancel never trips the standard `worst_gap + 12h` cushion (a daily cron → 36h, which spans two cycles).

**Why:** This is how the BSC Daily digest carrier (`data-health-check.yml`, the only surface for all non-critical alerting) went dark on cancelled runs (2/14 cancelled) with nothing to flag it (Notion 381637c5-416f-81af, 2026-06-16). The dual blind spot has recurred — see `update-theatr` (cancelled while pending in shared concurrency group) and the `test.yml`-on-main green-resets-clock special case.

**How to apply:** To monitor a daily carrier against cancellation, add it to `CRITICAL_CRONS` with a max_hours TIGHTER than the next-cycle reset — e.g. 26h when the carrier runs at 07 UTC and check-cron-health runs at 12 UTC (last success is ~28h old at noon on a cancel day → caught same day). Register the tight value in `audit-cron-health-coverage.js` `TIGHT_BY_DESIGN` so the cushion audit doesn't warn and a future maintainer can't "fix" it back to 36h. Accept the residual: a single cancel preceded by a >3h-late prior success may slip a day (check-cron-health's own lag usually catches it), and sustained outages always trip since no success accumulates. Links: [[feedback_if_always_does_not_run_on_cancel.md]], [[feedback_github_cron_delays.md]].
