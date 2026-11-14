---
name: Cats Opening Night Postmortem (2026-04-07)
description: Sixth opening night failure - 17 issues found, root causes and fixes for each
type: project
archived: true
---

# Cats: The Jellicle Ball Opening Night Postmortem (2026-04-07)

**Show:** cats-the-jellicle-ball-2026 | **Opening:** Apr 7, 2026
**Final:** 88/100, 22 reviews (20 positive, 1 mixed, 1 in dispute)

## Issues Found (17 total, in order of discovery)

### 1. Show missing `market` field
- **Root cause:** TodayTix discovery didn't set market field
- **Fix:** Manual `market: "broadway"` addition
- **Prevention:** `validate-data.js` must REQUIRE market field on every show

### 2. SERP found OB reviews instead of Broadway (27/32 wrongProduction)
- **Root cause:** Pipeline is SERP-first. OB reviews rank higher than just-published Broadway reviews
- **Prevention:** AGGREGATOR-FIRST on opening night: scrape BWW RR + Playbill Verdict first (they compile correct Broadway URLs), SERP only as fallback

### 3. Opening Night Poller skipped Cats entirely
- **Root cause:** Possibly missing market field; poller only monitored WE shows
- **Prevention:** Poller must include ALL shows with openingDate = today

### 4. Deploy blocked by duplicate "Into The Woods" in private data repo
- **Root cause:** Private data repo had stale `into-the-woods-west-end-2026` alongside 2025
- **Prevention:** Run `validate-shows-prebuild.js` on private data repo too, not just at deploy time

### 5. LLM scoring scored 0 reviews (first run)
- **Root cause:** Review texts collected locally weren't pushed to private repo before CI scoring
- **Prevention:** Opening night pipeline must push texts before triggering scoring

### 6. Review text collection hanging on paywalled sites
- **Root cause:** No per-URL timeout in batch collector
- **Prevention:** 60s per-URL timeout. Skip and continue, don't block the batch.

### 7. Talkin' Broadway Cloudflare-blocked
- **Root cause:** TB added Cloudflare; Playwright stealth insufficient
- **Prevention:** TB-specific cookie approach or accept manual paste for TB

### 8. No DTLI slug mapped for show
- **Root cause:** DTLI slug mapping never run for this show
- **Prevention:** Auto-discover DTLI slugs in `discover-new-shows.js`

### 9. Scored reviews not appearing on site (13 of 20+)
- **Root cause:** Sequential pipeline (collect → push → score → rebuild → deploy) with each step taking 5-10 min. Also: concurrent CI runs overwriting each other's scores via push-review-texts rebase.
- **Prevention:** Single integrated opening night workflow. Fix the data race in push-review-texts.

### 10. BWW RR had correct URLs but pipeline used old OB URLs
- **Root cause:** SERP ran first, found OB reviews. BWW RR wasn't checked.
- **Prevention:** BWW RR = primary URL source on opening night, not SERP

### 11. NYTG wrongProduction flag on correct Broadway review
- **Root cause:** gather-reviews found OB URL first; didn't check for newer Broadway URL at same outlet
- **Prevention:** On opening night, re-check all wrongProduction files for same-outlet Broadway URLs

### 12. Playbill feature article scored as a review
- **Root cause:** SERP returned March 18 feature article; collector LLM didn't flag as non-review; manual scoring didn't read content before scoring
- **Prevention:** (1) Classify content type (review vs feature/interview/news) in collector. (2) Never score without verifying it IS a review.

### 13. Pre-opening LLM scores persisted (Time Out scored 30 for 5-star review)
- **Root cause:** OB text scored in Feb 2026; score wasn't cleared for Broadway version. LLM misread franchise criticism as show criticism.
- **Prevention:** Opening night must clear ALL existing LLM scores and rescore from scratch

### 14. NYT Critics' Pick badge missed
- **Root cause:** Text extraction stripped the UI badge element. `isCriticsPick` not extracted from HTML metadata.
- **Prevention:** collect-review-texts.js must extract `isCriticsPick` from NYT HTML (appears 7 times in page source)

### 15. Guardian review kept getting re-flagged wrongProduction by CI
- **Root cause:** Guardian API `webPublicationDate` returns OB date (Dec 2025) for the Broadway review URL. Rebuild's wrong-production audit uses this date, overrides file's publishDate, renames to "observer", re-flags as wrongProduction.
- **Prevention:** Rebuild must respect `humanReviewedWrongProduction` and `publishDateVerified` fields. Also: Guardian API date bug needs investigation.

### 16. Chris Jones syndication counted twice (Chicago Tribune + NY Daily News)
- **Root cause:** Same review published in two outlets. `duplicateOf` flag set but CI overwrote it.
- **Prevention:** Syndication detection must be persistent — `duplicateOf` should be protected in push-review-texts action (add to PROTECTED_FIELDS list)

### 17. NYT paywall truncation undetectable + unrepairable
- **Root cause chain:** (1) Bright Data got 3,392 chars of real review text (truncated by paywall). (2) Collector set `contentTier: complete` because text looked valid. (3) With complete tier, collector never retries. (4) Ensemble scorer rejected as garbage_text. (5) Manual fix to `contentTier: truncated` gets overwritten by concurrent CI runs. (6) Cookie bundles don't contain valid NYT subscriber cookies or cookies can't bypass NYT's paywall for this article.
- **Prevention:** (a) Paywall truncation heuristic: if NYT review < 5,000 chars, flag as truncated. (b) Add `duplicateOf` to push-review-texts PROTECTED_FIELDS to prevent CI overwrite. (c) Refresh NYT cookies in COOKIES_BUNDLE secrets. (d) The bigger fix: push-review-texts must not overwrite human-verified fields.

## The Meta-Problem: Concurrent CI Runs Overwrite Each Other

The single biggest systemic issue across issues #5, #9, #15, #16, #17:

**Multiple CI workflows (scoring, rebuild, collection, poller) all write to the same review-texts repo.** When they run concurrently, `git pull --rebase` silently drops changes from other runs. Fields set by one workflow get overwritten by another.

Affected fields tonight: `ensembleScore`, `contentTier`, `wrongProduction`, `duplicateOf`, `publishDate`, outlet name/filename.

**Fix:** The push-review-texts action's PROTECTED_FIELDS list must include ALL human-verified and pipeline-critical fields: `duplicateOf`, `contentTier`, `publishDate`, `publishDateVerified`, `humanReviewedWrongProduction`, `isCriticsPick`. And `git pull --rebase` must do field-level merge, not file-level overwrite.

## Timing
- Reviews appeared: ~9:00 PM ET
- Score live on site (91/100, 10 reviews): ~10:46 PM ET
- 16 reviews live: ~11:15 PM ET
- 20 reviews live: ~12:50 AM ET
- 22 reviews live (morning): ~8:00 AM ET

**Time to first score: ~1h 45m** — target is <30 min.
**Time to full coverage: ~4h** — target is <1h.

## Opening Tomorrow
Another opening night tomorrow. Critical pre-checks:
1. Verify show has `market` field
2. Verify DTLI slug is mapped
3. Verify no stale wrongProduction scores from prior productions
4. Have BWW RR + Playbill Verdict URLs ready to paste
5. Clear all existing LLM scores for the show
6. Don't push to review-texts repo while CI is scoring (data race)
