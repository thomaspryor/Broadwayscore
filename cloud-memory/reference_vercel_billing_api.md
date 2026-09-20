---
name: reference-vercel-billing-api
description: How to pull Vercel invoices/usage via API + 2026-07 cost-driver findings (deploy frequency drives ~$67/mo of usage); also covers the Vercel DNS records API
metadata: 
  node_type: memory
  type: reference
  originSessionId: 7eb56e93-0b3f-45ba-9f4a-0e817b217c32
  modified: 2026-09-17T22:52:16.574Z
---

**Vercel billing via API** (VERCEL_TOKEN in .env, team `team_zvgatcxkXdPbfhtHQMOnjpXo`):
- `GET https://api.vercel.com/v1/invoices?teamId=<team>` — past invoices with per-line-item amounts/periods.
- `GET https://api.vercel.com/v1/invoices/upcoming?teamId=<team>` — current-period accrual with `quantity` + unit price per line item. This is the number the dashboard "current charges" shows.
- `GET /v1/usage` rejects all date formats tried ("timerange not supported") — use the upcoming invoice instead.
- `GET /v6/deployments?teamId=&limit=100&until=<ms>` — paginate with `pagination.next`/last `createdAt`.

**2026-07-19 findings:** usage $22→$37→$75/mo (Mar→Jun periods); driver is ~139 READY production builds/day (5-min cron gate only checks HEAD-moved; ~1,000 bookkeeping commits/day means it always passes; only 7% of commits are site-relevant). Each build = ~2,473 ISR writes + 7.4 CPU-min + edge-cache invalidation. ISR Writes/Fast Origin Transfer/Build CPU ≈ $67 of $69 usage. Fix direction: content-aware should-deploy gate (diff site-relevant paths vs last-deployed SHA) — task #161. Also: git integration creates ~680 canceled phantom deployments/day (cost $0, ignored-build-step `exit 0`). Full writeup: ~/Documents/claude-outputs/vercel-cost-analysis-2026-07-19.md

**DNS records API (2026-09-17, BRO-2600):** broadwayscorecard.com's nameservers are `ns1/ns2.vercel-dns.com` (registrar="new", `serviceType: zeit.world`) — DNS lives in Vercel, not a separate registrar/DNS provider, so no external DNS tool is needed to edit records.
- `GET https://api.vercel.com/v4/domains/<domain>/records?teamId=<team>&limit=100` — list all records (id, name, type, value).
- `PATCH https://api.vercel.com/v4/domains/<domain>/records/<recordId>?teamId=<team>` with `{"value": "..."}` — updates a record IN PLACE (same `createdAt`, no duplicate record created) but the response (and every subsequent GET) reports a **different `id`** for the same record — don't diff/key on record id across an update, key on `name`+`type`. No separate delete+recreate needed.
- No local `.env` had a Vercel DNS-specific token; the existing `VERCEL_TOKEN` (team `team_zvgatcxkXdPbfhtHQMOnjpXo`) already has DNS-record write scope.
- Propagation: writes land at Vercel's own authoritative nameservers within ~1-2 min even with a 60s TTL record (confirmed via `dig +short TXT <name> @ns1.vercel-dns.com`); check the authoritative NS directly rather than a public resolver like 8.8.8.8 if you need the earliest possible confirmation.
