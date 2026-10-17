---
name: workflow-cascade-prevention
description: Trace dispatch graph — circular chains blew up to 1000+ runs/day.
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 95a5d861-cfa7-43b7-91fb-711151fb4018
---

Never create circular workflow dispatch chains. Before adding `gh workflow run X` to any workflow, trace the full chain: does X (or anything X triggers) eventually dispatch back to the current workflow?

**Why:** On 2026-04-01, a Rebuild→Scoring→Rebuild→PullQuotes→Rebuild loop caused 1000+ GitHub Actions runs/day and 190+ Vercel deploys/day, burning 75% of Vercel credits in 11 days. The loop was invisible because each individual dispatch had dedup guards — but the guards only checked "is it running right now?" not "will this create a cycle?"

**How to apply:**
- When adding `gh workflow run` to any workflow, draw the dispatch graph first
- Prefer daily cron pickup over immediate dispatch for non-urgent data (scores, pull quotes, consensus)
- Opening night fast-path is handled by the orchestrator/poller — don't duplicate it in the scoring/extraction chain
- `workflow_run` triggers are especially dangerous (fire on EVERY completion of the source workflow)
- Demo/Lighthouse should NEVER use `workflow_run` on deploy — use daily cron instead

**Related: per-push deploys cascade with parallel sessions (2026-05-16).** The original `vercel-deploy.yml` triggered on `push: branches: [main]` with a per-run concurrency group. With 10+ parallel Claude Code sessions pushing to main throughout the day, this produced cascading Vercel-side cancellations — every deploy got killed mid-prerender by the next push before any could complete. The "cure" (per-run group + Vercel server-side dedup) became the problem at scale. **Fix shipped:** replaced push trigger with `schedule: '*/5 * * * *'` + a `should-deploy` preflight job that skips ticks where main HEAD hasn't moved since the last successful deploy. Manual `workflow_dispatch` and `workflow_run` from rebuilds still always proceed (ship-now path). Matches the demo workflow's identical 2026-04-01 fix. **Don't manually `gh workflow run "Deploy to Vercel"` after a normal push** — the cron handles it; manual dispatch races with the cron and re-triggers the cascade. CLAUDE.md §2 has the updated guidance.
