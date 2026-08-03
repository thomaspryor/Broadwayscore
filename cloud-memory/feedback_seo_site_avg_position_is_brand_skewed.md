---
name: feedback_seo_site_avg_position_is_brand_skewed
description: GSC site-wide avg position is brand-skewed; never report it as ranking quality — use de-branded review-intent rankings
metadata: 
  node_type: memory
  type: feedback
  originSessionId: a4a27c82-30bd-4a8b-97e6-98bd882b50e8
---

The GSC site-wide **average position (~9.6)** is NOT a ranking-quality signal. It is dragged toward #1 by the brand term ("broadway scorecard" ranks #1, ~19% of all clicks). The real signal — how we rank for "[show] reviews" queries — is **avg position ~14.7 with only ~28% on page 1** (71% page-2 or worse). For competitive marquee titles (Death of a Salesman, Schmigadoon, Glengarry) we are **not even in the top 10**; page 1 is the original outlets we aggregate (NYT, Guardian, londontheatre, theatrely), Reddit, social, and our direct competitor **Show-Score** (same aggregator model, beats us head-to-head).

**Why:** 2026-06-21 I reported "strong rankings, position 9.6" to the user off the brand-skewed number. User pushed back ("I don't believe we have strong rankings for [show] reviews") and was right. Reporting the headline GSC average as ranking quality is a false-confidence trap.

**How to apply:**
- Never cite GSC site-wide avg position as evidence of ranking strength. Cite the **de-branded review-intent distribution** instead.
- The weekly check now tracks it: `checkReviewIntentRankings()` in `scripts/check-seo-health.js` + `reviewIntentRankings` in the snapshot + `reviewIntentAvgPosition`/`reviewIntentPage1Share` in history. Summary labels the brand-skewed number explicitly.
- Ad-hoc deep dive: `scripts/analyze-show-review-rankings.js` (run via `analyze-show-review-rankings.yml` workflow_dispatch) — buckets all review queries + lists page-2 opportunities with demand.
- On-page is essentially MAXED (verified 2026-06-21): title now front-loads `[Show] Reviews —` (all 5 tiers, fixed the keyword-less "Worth Seeing" tier); schema already had aggregateRating stars + FAQ + dateModified + Review objects; consensus/audience-split/pull-quotes already rendered; field CWV already healthy. Added review-intent FAQ ("What do critics say about [show]?") + Organization `sameAs`. Don't go hunting for more on-page wins — they're done.

**The real lever is AUTHORITY, not content (user: "I have coverage. More than any other sites.").** We have the best coverage but rank page 2 because the web doesn't cite us yet. This is the Metacritic/RT playbook: become the cited score (Wikipedia "Critical response" sections, press citations, "scored X/100 on Broadway Scorecard"). Off-page — outreach/PR/partnerships, not code.
- **Citation system already EXISTS but was buried** (verify before building — it bit me 4× this session): `/api/badge/[slug]` (auto-updating SVG), `/embed/[slug]` (iframe), `/partners` (copy-paste snippets w/ attribution). All live. Fixed: added `/partners`+`/brand` to sitemap (were missing → Google couldn't surface them). STILL OPEN (user's call): no "Cite this score" affordance on show pages themselves — only linked from buried /brand + /terms. That's the one remaining authority-loop code lever.
- Coverage gather is NOT the lever (user confirmed coverage is the moat). A 4-show gather timed out at gather-reviews.yml's 30-min job cap; dropped rather than re-run.

**Two GSC metric-reading traps that produced a false P1 (task #530, 2026-08-02).** Both cost a full session before the numbers were re-derived from the API:
- **The impressions/clicks/position figures in `seo-health.json` are a 7-DAY window** (`endDate = today-3`, `startDate = endDate-7`), not trailing-28d. The card that raised #530 said "34% drop, trailing 28d" — that was two adjacent weekly rows. On real 28-day windows the site was UP 2.5% impressions / 3.4% clicks. Recompute the window before believing any drop framed as 28d.
- **`lcp` and `lcpLab` in the same CWV record mean different things.** `lcp` is CrUX FIELD data (real visitors); `lcpLab` is simulated Lighthouse. #530's card cited "Homepage LCP 6566ms" — that was `lcpLab`. Field LCP was 1,467ms, comfortably inside Good. Never cite `lcpLab` as what users experience.
- **An impressions drop with FLAT-OR-RISING clicks is usually a scraper leaving, not a ranking loss.** Third parties issue `site:` / stacked-exact-phrase queries that earn thousands of zero-click impressions and drag average position the WRONG way when they stop. `performance.botSignature` in `seo-health.json` now records the weekly bot census — read it first. Detection lives in `scripts/lib/seo-bot-query-signature.js`.
