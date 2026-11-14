---
name: sb-serp-invisible-burn
description: "SB SERP calls log NOTHING on success — 60-100K credits/day burned invisibly by poller's preferSpeed=SB-primary + SD-empty fallthrough. Log-based audits cannot see this path."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 7bb9fe54-d348-4630-8cb8-968f5460b90d
  modified: 2026-07-19T23:55:39.680Z
---

The 2026-07-05 ScrapingBee cost incident: the account burned its full 2M monthly credits while every log-based audit said "CI barely uses SB."

**Why:** `_serpViaScrapingBee` in `scripts/lib/url-discovery.js` emits no telemetry and no log line on success (~25 credits/query via `/api/v1/store/google`). With `preferSpeed=true` (opening-night poller), SB is the PRIMARY SERP provider. The Scrapingdog tier fails 60-70% on operator queries (HTTP 404 from api.scrapingdog.com/google/ on `site:`/quoted/`after:` queries) and its empty-but-successful results fall through to SB anyway (`sdResults.length > 0` is the only short-circuit). Empty results are deliberately not cached on the preferSpeed path, so identical queries re-fire every ~25-min poll cycle. Net: ~2,800+ invisible SB SERP calls/day tracking the opening calendar.

**How to apply:**
- Never conclude "X isn't being used" from CI logs alone — a code path with no logging is invisible. Cross-check the PROVIDER's billing counter (`app.scrapingbee.com/api/v1/usage` — cumulative per cycle; sample it over time to measure live burn rate and catch the consumer in the act).
- SB usage API has NO daily/history endpoints (404) — only the dashboard chart shows per-day. Live counter sampling is the programmatic substitute.
- `gh run list` silently caps at 20 rows — use `gh api --paginate .../actions/runs?created=...` for real run counts (Collect Review Texts ran 59×/day when `gh run list` showed 20/21 days).
- Failed SB calls (401/500) cost 0 credits — 401 noise in logs says nothing about spend.
- `scripts/audit-sb-spend.js` attributes SB credits per workflow from run logs (self-reported "(N credits" + [SB Call] telemetry + grosses-css signals) — but it CANNOT see unlogged paths; compare its total vs dashboard and treat the residual as unattributed.
- **Applied 2026-07-19** (main@76beaf43323 + e80a79aff42): `_serpViaScrapingBee` now emits `recordSbCall` on every attempt (25cr success / 0cr failure), has a per-process `SERP_SB_MAX_CALLS_PER_RUN` cap (default 40; per matrix SHARD, so parallel_jobs=3 → 120), `SERP_NO_SB=1` env + `serpQuery({skipProviders})` skip (backfill dispatches pass `no_sb_serp=true`), and skip-truncated empty results are never cached. `scraper-cost-report.yml` revived (was timeout-cancelled 8 straight Mondays) with a provider-reported ground-truth section; SD/BD/Browserbase balances now in `health-check.js checkAPICredits` daily digest.
- STILL OPEN: SD SERP 404 encoding fix + treat SD empty-success as authoritative (don't cascade), preferSpeed fallback swap, direct-SB caller migration (tasks #66/#5), fetchJSON reorder (task #203).

Related: [[feedback_scraper_architecture]], [[feedback_sb_credit_budget]], [[feedback_investigate_premise_before_scaling]]
