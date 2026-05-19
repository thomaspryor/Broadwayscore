---
name: feedback_same_title_disambiguation
description: "Multi-production same-title routing — extend classifyMarketRouting at the single chokepoint (createOrMergeReviewFile), don't add a new resolver. Stamp wrongProduction with humanReviewedWrongProduction guard."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: f74c0270-cd19-4680-9ffa-ae3eb93cf22f
---

When the catalog has multiple shows sharing a normalized title (titanique ×3, hadestown ×2, oh-mary ×2, etc.), URL-based discovery pipelines can file a review under the wrong production. The classifier handles this via a same-market same-title cascade.

**Why:** 2026-05-17 audit (`data/audit/same-title-confusion.json`) found 9 latent misattributions across the catalog — e.g., a 2019 Variety Hadestown review filed under hadestown-west-end-2024, a 2010 AP Lend Me a Tenor article filed under 1989. The runtime classifier didn't disambiguate same-title same-market siblings until Sprint 2 of the same-title-disambig plan (commit `a169936e48` and follow-ups).

**How to apply:**

1. **DON'T** add a new resolver in `scripts/lib/title-match.js` for production disambiguation. That was the wrong design in the original plan (Code Design reviewer flagged P0). The right shape is to **extend `classifyMarketRouting` in `scripts/lib/market-routing.js`**. Every scraper writes through `createOrMergeReviewFile` in `scripts/lib/review-file-writer.js`, which calls the classifier. Single chokepoint.

2. **Signal cascade** for the same-market same-title branch:
   - `url-year` — `urlYearFromPath(url)` exported from `scripts/lib/review-guards.js` (±1 year window)
   - `publish-date` — review's publishDate inside a sibling's production window
   - `venue-substring` — sibling venue token (≥5 chars, filtered by `GENERIC_VENUE_SLUGS` from `scripts/lib/venue-classification.js`) appears in URL
   - **Require ≥2 signals AND top.signals > current.signals** before returning `reroute`
   - **Single signal on sibling, zero on current** → `{action: 'accept', flag: 'wrongProduction', reason: 'ambiguous-production'}` (writer stamps the file)
   - **Otherwise** → plain accept

3. **Writer integration** (`review-file-writer.js`):
   - Honor `decision.flag === 'wrongProduction'` from classifier by stamping `wrongProduction: true` + `wrongProductionReason` on the payload BEFORE merge
   - **CRITICAL GUARD**: Skip the stamp when existing review has `humanReviewedWrongProduction === false`, `wrongProductionManualClear === true`, `wrongProductionOverride === true`, OR `wrongProduction === false` (explicit). The merge gate `!existing[key]` is true for false-values, so without this guard the classifier clobbers human overrides.

4. **Null-category protection**: When `sibData.category` is null OR any sibling has null category, skip the same-market branch entirely. Per `feedback_shows_json_category_at_schedule.md`, new shows often have null category pre-opening; same-market routing on null = collapsing to Broadway pool.

5. **`DISABLE_PRODUCTION_DISAMBIG=true`** env-var short-circuits ONLY the new same-market branch. Cross-market Tier 1/Tier 2 unaffected.

6. **Outlet-poller wiring**: `outlet-listing-poller.js` previously called `safeWriteReview` directly — bypassed the classifier. Now routes through `createOrMergeReviewFile`. Any scraper or poller that writes review files MUST route through that single chokepoint or the disambig won't fire.

7. **Audit script**: `scripts/audit-cross-production.js --dry-run` writes findings to `data/audit/same-title-confusion.json` WITHOUT mutating any review files. Run when investigating coverage gaps on multi-production shows.

8. **Cross-market Tier 1 threshold**: Same-title sibling pairs where current show and sibling are in DIFFERENT market pools (nyc vs london) use `CROSS_MARKET_SIBLING_CLOSE_DAYS=60` instead of `SIBLING_CLOSE_DAYS=30`. Cross-market pairs have larger natural publication lag. Guard: BOTH `sibData.category` AND `sib.category` must be non-null for `isCrossMarketSib` to fire — `getMarketPool('')` returns 'nyc' by design, so a null-category WE show would otherwise be treated as same-pool as a Broadway sibling.

9. **Weekly audit workflow**: `.github/workflows/audit-cross-production-weekly.yml` runs Sundays 14:00 UTC, commits `data/audit/same-title-confusion.json` to the public repo, and annotates the finding delta (warns when CURR-PREV>3).

10. **Tests**:
    - `tests/unit/classify-market-routing-siblings.test.mjs` — 8 fixture cases (test 8: cross-market 32d fires at 60d threshold, oh-mary style)
    - `tests/unit/classify-market-routing-parity.test.mjs` — 95-sample snapshot regression guard. ALLOWED_DIFFS in the test lists known intentional flips; any other diff fails.
    - Both registered in `.github/workflows/test.yml`

11. **Things this design deliberately does NOT do**:
   - Doesn't handle DIFFERENT normalized titles (e.g., "Cats" vs "CATS: The Jellicle Ball" normalize differently — the cats-jellicle-ball reviews bug was a different class). For that, use the BWW-extractor URL audit + manual flag.
   - Doesn't use cast/star name signals (Devil's Advocate flagged unverified shows.json cast coverage on old productions).
   - Doesn't drain `_pending/needs-production-disambig/` — ambiguous cases get `wrongProduction` flag on the most-likely candidate's directory instead of a new pending pile.

Related: [[feedback_orphan_utility_scripts]] (don't reinvent), [[feedback_protected_fields_three_way_sync]] (humanReviewedWrongProduction is protected at the writer), [[feedback_refactor_parity_test]] (parity test pattern), [[feedback_test_format_node_not_jest]] (`.mjs` + `node:test`).
