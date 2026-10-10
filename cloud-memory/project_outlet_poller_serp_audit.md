---
name: project_outlet_poller_serp_audit
description: Outlet listing poller SERP-only audit (2026-05-18) — which outlets remain on SERP and why
archived: true
metadata: 
  node_type: memory
  type: project
  originSessionId: fa73110b-68af-41f4-b33e-62333300ab43
---

Audited all 25 SERP-only qualifying outlets (≥5 shows reviewed in last 4 months) on 2026-05-18. None can be upgraded to RSS/listing-html/sitemap.

**Why:** All remaining SERP outlets fall into one of these categories:
- Hard paywall + bot protection (DataDome/Cloudflare): times-uk, wsj, telegraph, financialtimes, washpost, newyorker, independent, daily-mail
- JS-rendered SPA (requires Playwright, no RSS): new-york-sun (Next.js), theatrely (empty response), everything-theatre (empty response)
- Non-chronological per-show URL structure (no listings page): cititour, talkinbroadway
- Mixed content listing pages with only ~1/13 theater links: deadline

**How to apply:** Don't re-investigate these outlets. SERP is the permanent strategy for all 25. The only exception would be if one of the paywalled outlets adds a free RSS feed or removes their bot protection (extremely unlikely).

**Outlet counts (as of 2026-05-18):**
- 40 outlets with explicit RSS/sitemap/listing-html/wp-api strategies
- 25 outlets on SERP fallback (all genuinely non-upgradeable)
- 3 outlets skipped entirely (broadwayworld, london-theatre, london-box-office — dedicated scrapers)
