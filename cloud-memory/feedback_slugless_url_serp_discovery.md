---
name: feedback-slugless-url-serp-discovery
description: "SERP discovery silently drops slugless-URL outlets (FT /content/{uuid}) at the urlLooksLikeReview slug guard even when registered + in the target set"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 43525bf6-1903-444f-9328-9143a45ff768
---

FT theatre reviews live at `https://www.ft.com/content/{uuid}` — no show title in the path. The opening-night poller's SERP path (`opening-night-poller.js runSERPBackup` → `url-discovery.js discoverCorrectUrl`) rejected **every** FT URL at the cross-show slug guard `if (showInfo.title && !urlLooksLikeReview(url, showInfo.title)) continue;`, because `urlLooksLikeReview` requires show-title words in the URL path. FT was correctly registered (`region=london`, `isDualMarket`) and confirmed **in** `getMissingT1T2Outlets` for WE shows, so it was queried every opening night and the result thrown away. Fixed 2026-06-05 (commit a80199b2e5).

**Why:** "registered + in the SERP target set" is necessary but NOT sufficient for discovery — the per-result URL-acceptance guard can silently drop an outlet whose URL format carries no slug. The gap is invisible: no error, no log, the outlet just never appears.

**How to apply:**
- For a slugless-URL outlet, exempt it from the slug guard (`isSluglessReviewUrl()` in review-guards.js matches `ft.com/content/*` precisely) and disambiguate via the **SERP result title** (`titleHasShow`, a substring match robust to "Show, Venue — review" headlines — `urlOrTitleLooksLikeReview`'s word-boundary match breaks on the comma after the title).
- The bypass forgoes `urlLooksLikeReview`'s URL-path content-type rejects (`/obituar` etc.), which don't apply to `/content/{uuid}` anyway, so add the content-type defense at the **title** level (`nonReviewTerms` includes `'obituar'`). Do NOT add broad tokens like `'appreciation'` — they collide with real review headlines (ship-check P1).
- Two SERP discovery paths exist with DIFFERENT validation: `discover-outlet-reviews-serp.js` (source `outlet-serp-discovery`) matches on SERP title only (no slug guard) — this is why some FT reviews already existed; the opening-night poller (source `serp-discovery`) uses the strict slug guard. When an outlet "sometimes works," check whether two paths disagree.
- `serp-discovery` is a `VERIFIED_DISCOVERY_SOURCE`, so the hit bypasses `_pending` and routes straight to the show dir for byline enrichment + scoring with the outlet's cookies. Don't assume no-byline SERP hits go to `_pending`.
- Verify discovery live: call `discoverCorrectUrl` for the outlet against a recent opening; confirm it returns the expected `/content/...` URL. Scoring is proven by existing data (One Flew Over FT scored 80 via the same cookie pipeline).

Related: [[feedback_systematic_fix_threat_model_first]], [[feedback_test_yml_push_path_allowlist]] (the 3 changed files weren't in test.yml push paths → zero CI; added them).
