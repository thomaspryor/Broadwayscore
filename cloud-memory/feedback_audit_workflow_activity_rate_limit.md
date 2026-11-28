---
name: feedback_audit_workflow_activity_rate_limit
description: audit-workflow-activity.js burns GitHub secondary rate limit — cache + spacing fix applied 2026-06-06
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 9b927c0c-9b60-4d37-aaab-5d4f2f334314
---

`node scripts/audit-workflow-activity.js` makes 372 API calls (2 per workflow × 186 workflows) at high concurrency. This hits GitHub's **secondary** rate limit and locks out ALL `gh` commands for ~1 hour.

**Why:** Secondary rate limit is a separate sliding-window anti-abuse system, not the primary 5000/hour quota. It fires on sustained burst rates and is NOT visible in `/rate_limit`.

**Fix applied 2026-06-06:** Script now uses a 24h `/tmp/bwsc-workflow-activity-cache.json` cache, 500ms inter-call spacing, and retry-with-backoff on 403. Re-runs cost 0 API calls.

**How to apply:**
- Run `node scripts/audit-workflow-activity.js` freely — it'll use cache
- Use `--force` flag only when you need fresh data (e.g. after re-enabling a workflow)
- **Never run with `--force` mid-session** if you need `gh` commands afterward — it will still burn ~372 calls and may hit the limit
- If you get a 403 on `gh run list` etc., the rate limit is already hit — wait ~1 hour; nothing to do
