---
name: feedback-pipeline-output-step-ordering
description: "In multi-step workflows, any step that marks work \"done\" (tracking commit) must run AFTER the step that produces the user-visible output (issue creation), or a cancellation between them silently loses the work"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: f91a2bc1-d017-48a2-9795-2cfd254003f0
---

A workflow that (a) marks input as processed with `if: always()` and (b) produces its output in a later `if: success()` step will silently swallow work whenever the job dies between the two — timeout, cancellation, runner loss. The input never re-surfaces (it's marked processed) and the output never existed.

**Incident:** process-feedback.yml run 28876301784 (2026-07-07). Erik Andersen's homepage-filter bug was fetched, categorized, and diagnosed; the push-with-retry tracking commit then ate the remaining 15-min timeout budget; the job was cancelled before "Create Bug Diagnosis Issues" ran. No issue, no auto-fix dispatch, no alert — and `notify-failure` ignores `conclusion=cancelled`, so nothing paged. Found only because the user asked "why didn't our automation propose a fix?"

**Why:** `if: always()` side-effects (commits, tracking writes) are ordering-sensitive against `if: success()` outputs. Push-retry steps have unbounded-ish latency under main-branch contention, so putting one before the output step turns every contention spike into silent data loss. Cancelled jobs also skip failure notifications by default, hiding the loss.

**How to apply:**
1. Order steps so user-visible outputs (issues, emails, dispatches) come BEFORE expensive/retrying side-effects (push-with-retry commits).
2. Persist intermediate work products to a committed file (e.g. `data/audit/pending-bug-diagnoses.json`), drain after output creation, and expose a `has_pending_*` output so the next run recovers leftovers.
3. Budget timeouts for the worst-case push-retry (7 attempts + backoff ≈ 15 min alone) — related: [[feedback-cron-timeout-needs-script-budget]].
4. When auditing "why didn't automation act", check the run's *step-level* conclusions — a run marked `cancelled` can have every executed step green.
