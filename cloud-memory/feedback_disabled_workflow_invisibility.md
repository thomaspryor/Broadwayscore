---
name: feedback_disabled_workflow_invisibility
description: "A `disabled_manually` workflow keeps emitting cancelled scheduled runs — recency-only health checks see them as fresh and miss the outage. Always verify state + require successful (not just recent) runs."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: f74c0270-cd19-4680-9ffa-ae3eb93cf22f
archived: true
---

When a GitHub Actions workflow is in state `disabled_manually`, its scheduled `cron` events keep firing on the queue — but every run is immediately cancelled. The runs still appear in `gh run list` with a fresh `createdAt` timestamp. Any health check that only looks at "how recent is the last run?" stays green even though zero work is happening.

**Why:** May 2026 — Opening Night Orchestrator (and 11 other workflows) were `disabled_manually` for ~2.5 days. `check-cron-health.yml` ran daily and never alerted because the cron firings kept looking "recent." Discovered only after a user-reported review-coverage gap. Root-caused by querying the workflows REST API directly and seeing the state field. Confirmed by `gh workflow run` returning HTTP 422 "Cannot trigger a 'workflow_dispatch' on a disabled workflow."

**How to apply:**
1. Any health check on scheduled workflows MUST query the workflow `state` field via `GET /repos/{owner}/{repo}/actions/workflows` and fail unless `state == "active"` (or an explicit allowlist of expected-disabled workflows like Opening Night Broadcast, Deploy-Secondary).
2. Recency checks must use `gh run list --status=success --limit=1`, not `--limit=1` alone. Cancelled runs are not progress.
3. `gh workflow list` (the CLI) can show `active` for a workflow the API reports as `disabled_manually`. The REST API is authoritative — trust `gh api repos/.../actions/workflows`, not the CLI summary.
4. The prevention now lives in `check-cron-health.yml`'s "Check critical crons" step (commit `f8e2b203c9`, 2026-05-16) — both fixes shipped together.
5. Process rule (already documented in [[feedback_opening_night_corrections]]): to pause the orchestrator, use `gh variable set ORCHESTRATOR_PAUSED --body true`, never the UI disable button. Disabling kills the schedule and leaves no recovery breadcrumb.

Related: [[feedback_404_not_terminal]] (similar pattern — a transient/intermediate state masking a real failure).
