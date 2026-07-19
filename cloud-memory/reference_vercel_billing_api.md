---
name: reference-vercel-billing-api
description: How to pull Vercel invoices/usage via API + 2026-07 cost-driver findings (deploy frequency drives ~$67/mo of usage)
metadata: 
  node_type: memory
  type: reference
  originSessionId: 7eb56e93-0b3f-45ba-9f4a-0e817b217c32
  modified: 2026-07-19T15:54:54.706Z
---

**Vercel billing via API** (VERCEL_TOKEN in .env, team `team_zvgatcxkXdPbfhtHQMOnjpXo`):
- `GET https://api.vercel.com/v1/invoices?teamId=<team>` — past invoices with per-line-item amounts/periods.
- `GET https://api.vercel.com/v1/invoices/upcoming?teamId=<team>` — current-period accrual with `quantity` + unit price per line item. This is the number the dashboard "current charges" shows.
- `GET /v1/usage` rejects all date formats tried ("timerange not supported") — use the upcoming invoice instead.
- `GET /v6/deployments?teamId=&limit=100&until=<ms>` — paginate with `pagination.next`/last `createdAt`.

**2026-07-19 findings:** usage $22→$37→$75/mo (Mar→Jun periods); driver is ~139 READY production builds/day (5-min cron gate only checks HEAD-moved; ~1,000 bookkeeping commits/day means it always passes; only 7% of commits are site-relevant). Each build = ~2,473 ISR writes + 7.4 CPU-min + edge-cache invalidation. ISR Writes/Fast Origin Transfer/Build CPU ≈ $67 of $69 usage. Fix direction: content-aware should-deploy gate (diff site-relevant paths vs last-deployed SHA) — task #161. Also: git integration creates ~680 canceled phantom deployments/day (cost $0, ignored-build-step `exit 0`). Full writeup: ~/Documents/claude-outputs/vercel-cost-analysis-2026-07-19.md
