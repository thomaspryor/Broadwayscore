# Broadway Scorecard: URL Contamination Audit

Date: 2026-02-27

## Executive Summary

Cross-domain contamination exists in the Broadway Scorecard review data pipeline.
The Playwright scraper in `scripts/collect-review-texts.js` reuses a browser page
across reviews. When `page.goto()` fails (timeout, redirect, paywall), the scraper
can capture HTML from the PREVIOUSLY loaded page, resulting in archived HTML and
extracted text belonging to a completely different website.

**Key findings:**
- **119 archived HTML files** have confirmed cross-domain contamination (content from
  a different domain than the review URL)
- **538 review-text JSON files** contain non-theater content (sports articles, fitness
  ads, paywall/login pages) stored in their `wrongFullText` or `fullText` fields
- **~683 review files** share identical content across different outlets (contamination
  fingerprint)
- **7 reviews were LLM-scored using wrong-domain content** (all 7 already flagged by
  content verification as `wrongArticle`, so scores are not used in production)
- The fresh-page fix (closing and reopening a page per review) exists in the current
  code at line 5341, but contamination occurred during batch runs on Feb 26-27, 2026

**Score impact: LOW.** Of 412 scored reviews with non-theater content, 405 were scored
from star ratings (aggregator scores), not from the contaminated text. The remaining 7
were all caught by content verification (`isValid: false`). No contaminated content
appears to have resulted in incorrect production scores.

---

## 1. Archived HTML Contamination (data/archives/reviews/)

**Total archived HTML files:** 2,118 (across 447 shows)
**Archive.org wrapping (legitimate):** 335
**Cross-domain contamination:** 119 (5.6%)

### Contamination by Date

| Date       | Contaminated | Total | Rate |
|------------|-------------|-------|------|
| 2026-02-27 | 69          | 1,170 | 6%   |
| 2026-02-26 | 48          | 824   | 6%   |
| 2026-02-22 | 1           | 58    | 2%   |
| 2026-02-20 | 1           | 37    | 3%   |

Contamination is consistent across dates at ~6%, suggesting a persistent bug rather
than a one-time incident.

### Top Contamination Patterns (by frequency)

| Source URL Domain | Contaminated With | Count | Notes |
|------------------|-------------------|-------|-------|
| vulture.com      | variety.com       | 12    | Vulture paywall -> Variety loads |
| nymag.com        | vulture.com       | 12    | Expected: nymag redirects to vulture |
| vulture.com      | hollywoodreporter.com | 5 | Paywall bounce |
| deadline.com     | ew.com            | 4     | Paywall redirect |
| newyorktheatreguide.com | variety.com | 3   | NYTG redirect -> Variety stale page |
| variety.com      | newyorktheater.me | 3     | Variety paywall -> stale page |
| hollywoodreporter.com | newyorktheater.me | 3 | THR paywall -> stale page |

**Notable individual cases:**
- `hamilton-2015/ap--mark-kennedy_2026-02-26.html`: AP News URL -> BroadwayWorld content
  (title: "Review: HADESTOWN, Lyric Theatre")
- `you-got-older-2026/nytimes--unknown_2026-02-27.html`: NYTimes URL -> The Guardian content
- `you-got-older-2026/nytimes--unknown_2026-02-26.html`: NYTimes URL -> Washington Post content
  (title: "Aladdin opens on Broadway")
- `oklahoma-1979/nytimes--ben-brantley_2026-02-27.html`: NYTimes URL -> Variety content
- Multiple variety.com URLs -> "NY Diamond Color Guide" (a domain squatter at nytheatreguide.com)

### Impact on Scored Reviews

Of the 119 contaminated archives:
- 99 have matching review-text JSON files
- 89 of those are scored
- **All 89 scored reviews have star ratings (assignedScore)** from aggregators
- **0 reviews were LLM-scored from contaminated archive content**

The archive contamination is cosmetically bad but has no impact on production scores
because scores derive from star ratings/excerpts, not from the archived HTML.

---

## 2. Review-Text File Contamination (data/review-texts/)

**Total review-text files:** 31,406

### Flagged Content Statistics

| Category | Count |
|----------|-------|
| `wrongArticle: true` | 1,536 |
| `contentVerification.isValid: false` | 2,455 |
| `incompleteReason: wrong_content` | 8,396 |
| Successful fetch but `contentTier: stub` | 400 |
| Successful fetch but `contentTier: invalid` | 3,027 |

### Non-Theater Content Patterns

**538 review files contain completely non-theater content.** The top patterns:

| Content Pattern | Count | Outlet(s) | Type |
|----------------|-------|-----------|------|
| Michigan State football article | 157 | nydailynews | Sports article (redirect contamination) |
| Home fitness device ad | 188 | nypost | Product ad (AMP redirect contamination) |
| Shucked national tour article | 10 | broadwayworld | Wrong article from same outlet |
| "How I Learned to Drive" promo | 8 | theatermania | Wrong article from same outlet |
| Streetcar Named Desire / Variety | 6 | variety, vulture | Cross-outlet contamination |

The **NYPost fitness ad (188 files)** and **NYDN Michigan State football (157 files)**
are the two dominant contamination patterns. These appear to be AMP redirect failures:
when the scraper tries the AMP version of old NYDN/NYPost URLs, it gets redirected to
a generic page (paywall/ad landing) instead of the actual article.

### Cross-Outlet Duplicate Content (Contamination Fingerprint)

**475 groups of identical content found across different outlets, affecting ~683 files.**

Top duplicated content:
- Michigan State football: 157 files (all nydailynews)
- Variety/Newsday content leak: 79 files (variety, vulture, newsday)
- Vulture login/paywall page: 76 files (vulture, nytimes, newyorker, hollywood-reporter)
- TheaterNewsOnline domain-for-sale page: 47 files
- "Social media marketing" spam: 38 files (faster-times, backstage, northjersey, etc.)
- "NY Diamond Color Guide" domain squatter: 35 files (nytg, hollywood-reporter, variety)
- Bloomberg login wall: 28 files

### Score Impact Analysis

Of the 538 non-theater content files:
- **412 are scored** (have llmScore, assignedScore, or humanReviewScore)
- **405 scored from star ratings** (safe - score not derived from wrong text)
- **7 LLM-scored from wrong text** (CRITICAL)

All 7 critical cases were already caught by content verification:

| File | Outlet | Score | Bucket | CV Status |
|------|--------|-------|--------|-----------|
| august-osage-county-2007/nydailynews--unknown.json | nydailynews | 68 | Mixed | wrongArticle: true |
| children-of-a-lesser-god-2018/theatermania--david-gordon.json | theatermania | 75 | Positive | wrongArticle: true |
| chita-rivera-the-dancers-life-2005/dctheatrescene--unknown.json | dctheatrescene | 82 | Positive | wrongArticle: true |
| jersey-boys-2005/travel-aol--steve-ramm.json | travel-aol | 75 | Positive | wrongArticle: false* |
| ragtime-2009/dc-theater-arts--deb-miller.json | dc-theater-arts | 92 | Rave | wrongArticle: false* |
| the-threepenny-opera-2006/nydailynews--joe-dziemianowicz.json | nydailynews | 30 | Pan | wrongArticle: true |
| therese-raquin-2015/theatermania--charles-isherwood.json | theatermania | 48 | Negative | wrongArticle: true |

*The two without `wrongArticle: true` have `contentVerification.isValid: false`, so
their scores are still excluded from the rebuild pipeline.

---

## 3. Root Cause Analysis

### Bug Mechanism

The Playwright scraper in `collect-review-texts.js` uses a shared browser page.
When `page.goto(url)` encounters:

1. **Paywall redirect** (NYT, WSJ, etc.): The page navigates to a login/paywall
   page, but the content extraction runs on whatever HTML is in the DOM
2. **Timeout**: `page.goto()` times out, but `page.content()` still returns the
   last successfully loaded page
3. **AMP redirect**: Old NYDN/NYPost AMP URLs redirect to generic landing pages
4. **Domain squatters**: Sites like theaternewsonline.com and nytheatreguide.com
   are no longer the original outlets

### Existing Mitigations

1. **Fresh page per review** (line 5341): The code creates a new page for each
   review, which prevents the MOST common contamination (stale page from previous
   review). However, this doesn't prevent contamination from login pages or
   redirects within the SAME review's fetch cycle.

2. **Content verification** (LLM-based): Reviews are checked post-collection for
   `wrongArticle`, `wrongShow`, `wrongProduction`, etc. This catches most cases.

3. **isBlocked / isPaywalled checks**: The scraper checks for known blocking
   patterns after loading.

### Gap in Mitigations

The fresh-page fix prevents inter-review contamination (review B getting review A's
content). But **intra-review contamination** remains possible:
- Login page content leaking into the main fetch
- AMP redirect landing pages being captured
- Retry loops where page.goto fails on the actual URL but succeeds on loading
  something else

---

## 4. Recommendations

### Immediate (no code changes needed)
1. **Re-collect the 7 critical LLM-scored files** with contaminated content
2. **Re-collect the 188 NYPost and 157 NYDN files** with recurring contamination
   patterns (or mark as permanently unfetchable)

### Short-term (code fixes)
3. **Add URL validation after page.goto()**: After loading a page, compare
   `page.url()` with the expected URL domain. If they don't match, log a warning
   and do NOT capture the content. This prevents redirect-based contamination.
4. **Add canonical URL verification**: After extracting HTML, check if the
   `<link rel="canonical">` matches the expected domain. Flag mismatches.
5. **Add content fingerprinting**: Hash the first 500 chars of extracted text.
   If the same hash appears across different outlets, flag for review.

### Long-term (pipeline improvements)
6. **Retire unfetchable URLs**: The NYDN and NYPost old-format URLs are permanently
   broken. Mark them as `incompleteReason: 'permanently_unavailable'` and stop
   retrying. Use aggregator excerpts for scoring instead.
7. **Archive.org fallback**: For paywalled outlets with old URLs, prioritize
   Wayback Machine fetches over Playwright (which will always hit the paywall).
8. **Post-collection dedup scan**: Add a CI step that checks for duplicate content
   across outlets (the 475 duplicate groups found in this audit).

---

## 5. Files Referenced

- Archive contamination data: `/tmp/archive-contamination.json` (119 entries)
- Scored contaminated reviews: `/tmp/contaminated-and-scored.json` (89 entries)
- Non-theater content: `/tmp/nontheater-content.json` (538 entries)
- Critical wrong-text scores: `/tmp/critical-contamination.json` (7 entries)
- Scraper source: `scripts/collect-review-texts.js` (fresh page fix at line 5341)
- Archive directory: `data/archives/reviews/` (2,118 HTML files, 447 shows)
- Review texts: `data/review-texts/` (31,406 JSON files)
