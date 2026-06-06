---
name: feedback_analytics_real_users_lens
description: How to pull trustworthy traffic numbers — GA4 Direct is bot-inflated; use PostHog Real Users lens (owner + bot geos excluded)
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 92c0c27f-40ed-4470-b31d-0d219f6fa42f
---

When analyzing site traffic, **GA4 over-counts badly and PostHog is the truth source.** GA4 reports ~2.5x PostHog (e.g. May 2026: GA 39,739 users vs PostHog 13,586 real-user visitors). The inflation is concentrated in GA4's **"Direct" channel** (~77% of GA sessions, ~18% engagement, 1.6 pages/session) — a bot/scraper signature. PostHog already filters most bots client-side.

**The "Real Users" lens** (added commit 507985b130, "tag-don't-block"):
- Exclude owner: `properties.is_owner != 'true'` (set via `?bwsc-owner=1` → localStorage → posthog super-property; GA4 `traffic_type=internal`).
- Exclude bot geos: `properties.$geoip_country_name NOT IN ('Singapore','China','Vietnam')`.
- Saved PostHog insights: `Real Users — Pageviews` (id 7864729), `Top Pages` (7864730), `Geo Sanity Check` (7864731). Project ID 332742.
- Applying the lens barely moves PostHog totals (it already filters bots) — the bot problem is a GA4-only artifact. Don't expect the lens to "fix" GA; just use PostHog.

**How to apply:** Query PostHog HogQL directly (`POSTHOG_PERSONAL_API_KEY`, project 332742) with the two RU clauses for any traffic trend. Treat GA4 only for channel/source shape, not absolute counts. Vercel Web Analytics has **no usable query API** (`/api/web-analytics/*` and `/api/web/insights/*` return 404) — skip it; read it in the dashboard only. See [[feedback_newsletter_no_utm]].
