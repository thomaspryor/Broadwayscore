---
name: github-auto-disable-workflows
description: GitHub auto-disables scheduled workflows after ~60 days without a successful cron run; check workflow state before assuming a feature is broken
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 8a0a2119-edf5-4d95-8afa-782753dcc756
---

GitHub silently auto-disables `schedule:` workflows when the cron hasn't run successfully for ~60 days. `gh workflow run` returns `HTTP 422: Cannot trigger a 'workflow_dispatch' on a disabled workflow`, and `gh workflow list` omits the workflow entirely (but `gh api repos/.../actions/workflows/{id}` may still show `state: active` if a manual UI re-enable happened).

**Why:** Hit 2026-05-16 with `scrape-bww-reviews.yml` — last successful scheduled run 2026-03-25, last attempt 2026-03-29 (failed), then 48 days of silence → auto-disabled. The "weekly Sunday cron will catch it" assumption was wrong because the cron itself was off.

**How to apply:**
- Before assuming a feature relies on a scheduled workflow that "should just run", verify the workflow isn't disabled: `gh workflow list --all | grep <name>` (omits disabled) vs `gh api repos/OWNER/REPO/actions/workflows/{id} --jq .state`.
- After a long gap of failed cron runs, expect the workflow to be auto-disabled even if logs look like it just stopped running.
- Re-enable via the GitHub UI (Settings → Actions → Workflows → ⋯ → Enable workflow) or `gh api -X PUT repos/OWNER/REPO/actions/workflows/{id}/enable`.
- The 5000/hr GitHub API rate limit is shared across `gh` and tools — back off polling if you see HTTP 403 with rate-limit body. Pair with `scripts/lib/dispatch-with-retry.sh` for workflow-to-workflow dispatches.
