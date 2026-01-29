# FullText Collection Strategies

**Last Updated:** 2026-01-28
**Current Coverage:** 62.1% (1,369 of 2,203 reviews have fullText)
**Reviews Needing Scraping:** 780 (have URL but no fullText >500 chars)

## Executive Summary

The current scraping system has a ~62% success rate with Archive.org being the most successful tier (11.1% success rate according to Jan 2026 data). This document outlines strategies to improve coverage, prioritized by expected impact and implementation effort.

---

## 1. Archive.org Wayback Machine Analysis

### Current Status
- **Already implemented** as Tier 4 (and Tier 0 for paywalled sites)
- Success rate: 11.1% - highest of all tiers
- Limitation: Many recent URLs (2024+) not yet archived

### Archive.org Availability Testing (Sample of 10 URLs)

| Domain | Sample URL Tested | Archived? | Notes |
|--------|------------------|-----------|-------|
| variety.com | 2024 review | No | Recent URLs not archived |
| nytimes.com | 2014 review | No | Older URLs also missing |
| vulture.com | 2014 review | **YES** | Archive from Nov 2024 |
| theguardian.com | 2014 review | No | - |
| hollywoodreporter.com | 2014 review | No | - |
| deadline.com | 2014 review | No | - |
| theatermania.com | 2014 review | No | - |
| wsj.com | 2014 review | No | - |

### Key Findings
1. Archive.org coverage is spotty - not all URLs are archived
2. Vulture has good archive coverage
3. Many paywalled sites are NOT archived (Archive.org respects robots.txt)
4. The script already tries Archive.org first for paywalled sites (archiveFirstSites list)

### Recommendations
- **KEEP:** Current archive-first approach for paywalled sites
- **ADD:** Try requesting Archive.org to crawl missing URLs via their "Save Page Now" feature (would need API integration)
- **PRIORITY:** Low - already well-implemented

---

## 2. Alternative URL Patterns

### Tested Patterns

| Pattern | Example | Status |
|---------|---------|--------|
| Mobile (m.domain.com) | m.nytimes.com | Most sites redirect to main |
| AMP (/amp/ suffix) | nytimes.com/article.amp.html | Returns 301 redirect |
| Print (?print=true) | nytimes.com?print=true | Returns 403 Forbidden |
| No www prefix | nytimes.com vs www.nytimes.com | Sometimes different archive results |

### Findings
- **AMP versions** are largely deprecated (Google ended AMP priority in 2021)
- **Print versions** often blocked or require auth
- **Mobile versions** typically redirect to responsive main site
- **URL normalization** matters for Archive.org - try both with and without www

### Recommendations
- **ADD:** URL normalization function to try both www and non-www variants with Archive.org
- **SKIP:** AMP and print versions - not worth the effort
- **PRIORITY:** Low

---

## 3. Google Cache

### Test Results
- Google Cache API endpoint: `webcache.googleusercontent.com`
- Test URL returned HTTP 200 (page exists)
- However, Google Cache is being deprecated and unreliable

### Challenges
1. Google Cache is being phased out
2. Requires specific URL format
3. Cache freshness varies widely
4. JavaScript-rendered content often missing

### Recommendations
- **SKIP:** Google Cache is too unreliable and being deprecated
- **PRIORITY:** Not recommended

---

## 4. Premium Proxy Strategies (ScrapingBee)

### Current Configuration
```javascript
// Standard: premium_proxy (10 credits/request)
// Stealth: stealth_proxy (75 credits/request)
```

### Outlet-Specific Analysis

Outlets that might benefit from stealth_proxy (high blocks, valuable content):

| Outlet | Current Failure Rate | Reviews Blocked | Worth Stealth? |
|--------|---------------------|-----------------|----------------|
| variety.com | 100% blocked | 77 | **YES** - Tier 1 outlet |
| theatermania.com | 48% blocked | 57 | **YES** - High volume |
| nydailynews.com | 51% blocked | 47 | Maybe |
| theguardian.com | 100% blocked | 46 | **YES** - Free content, just blocked |
| wsj.com | 100% blocked | 44 | Maybe - has subscription |
| hollywoodreporter.com | 100% blocked | 35 | **YES** - Tier 1 outlet |

### Cost Analysis
- 77 Variety reviews x 75 credits = 5,775 credits (~$5.78 at $1/1000)
- 57 TheaterMania reviews x 75 credits = 4,275 credits (~$4.28)
- Total for top outlets: ~$15-20 for potentially 200+ reviews

### Recommendations
- **ADD:** `--stealth-proxy` flag targeting specific outlets that consistently fail
- **IMPLEMENT:** Outlet-specific proxy strategy (use stealth only for known-blocked sites)
- **PRIORITY:** Medium-High - good ROI for Tier 1 outlets (Variety, Hollywood Reporter)

---

## 5. Outlet-Specific Strategies

### Top Failing Outlets (by volume)

#### 5.1 TheaterMania (57 failures)
- **Issue:** Heavy bot protection
- **Success rate:** 52%
- **Best method:** Archive.org (32 successes)
- **Strategy:** Try older URL patterns, Archive.org has decent coverage
- **Subscription available?** No - free site

#### 5.2 Variety (77 failures out of 137 total)
- **Issue:** Penske Media paywall + bot protection
- **Success rate:** 44% (60 successes)
- **Best method:** Mixed (Archive.org, Playwright on older URLs)
- **Strategy:** ScrapingBee stealth proxy for remaining 77, or accept excerpts
- **Subscription available?** Yes (expensive)
- **Note:** All 137 have excerpts - fallback scoring possible

#### 5.3 NY Daily News (47 failures)
- **Issue:** Tribune Publishing paywall
- **Success rate:** 49%
- **Best method:** Archive.org (37 successes)
- **Strategy:** Archive.org is already working well

#### 5.4 The Guardian (47 failures out of 48 total)
- **Issue:** Bot protection (content is free)
- **Success rate:** 2% (1 success)
- **Strategy:** ScrapingBee stealth - content is free, just blocked
- **Expected improvement:** HIGH - free content, just needs better proxy
- **Note:** All 48 have excerpts - fallback scoring possible

#### 5.5 Hollywood Reporter (35 failures out of 50 total)
- **Issue:** Penske Media (same as Variety)
- **Success rate:** 30% (15 successes)
- **Strategy:** Same as Variety - stealth proxy or excerpts
- **Note:** 48 have excerpts - fallback scoring possible

### Outlets with Good Existing Coverage (use as templates)
- **NYStageReview:** 85% success via Playwright + Archive
- **Theatrely:** 87% success via Playwright
- **Timeout:** 88% success via ScrapingBee
- **ChicagoTribune:** 80% success via Archive.org

---

## 6. Aggregator Excerpts as Fallback

### Current Excerpt Availability for Failed Reviews

| Excerpt Status | Count | Percentage |
|----------------|-------|------------|
| Has 2+ excerpts | 355 | 45.5% |
| Has 1 excerpt | 411 | 52.7% |
| Has no excerpts | 14 | 1.8% |

### Excerpt Sources Available
- DTLI excerpts: 579 reviews
- BWW excerpts: 234 reviews
- ShowScore excerpts: 343 reviews

### Can Combined Excerpts Work for Scoring?

**Analysis:**
- Typical excerpt length: 100-300 characters
- Combined 2-3 excerpts: 200-900 characters
- Minimum for accurate LLM scoring: ~500 characters (current threshold)
- Full review typical length: 1500-3000 characters

**Verdict:** Combined excerpts CAN work for scoring but with caveats:
1. Excerpts are curated to be quote-worthy (may skew positive)
2. Missing context about specific criticisms
3. LLM scoring should flag lower confidence

### Recommendations
- **IMPLEMENT:** "Excerpt-based scoring" mode for reviews where:
  - All tiers failed
  - Combined excerpt length >= 500 chars
  - Flag as `textQuality: "excerpts-only"` with lower confidence
- **TRACK:** Score variance between full-text and excerpt-only reviews
- **PRIORITY:** Medium - allows scoring 45% more failed reviews

---

## 7. RSS Feeds

### Testing Results
- Variety RSS: No full content (excerpts only)
- TheaterMania RSS: No RSS feed found
- Most outlets truncate RSS to drive traffic

### Verdict
- **SKIP:** RSS feeds are not useful for full content
- **PRIORITY:** Not recommended

---

## 8. Subscription Login Improvements

### Current Subscriptions Configured
| Site | Configured | Success Rate |
|------|------------|--------------|
| NYTimes | Yes | 72% |
| Vulture/NY Mag | Yes | 66% |
| Washington Post | Yes | ~50% |
| WSJ | Yes | ~0% (login issues?) |
| The New Yorker | Shares Vulture | 75% |

### Issues Identified
- WSJ login appears broken (0% success despite credentials)
- Some logins expire mid-session

### Recommendations
- **FIX:** Debug WSJ login flow - 44 reviews blocked
- **ADD:** Session persistence/cookie saving between runs
- **PRIORITY:** Medium - WSJ fix could recover 44 reviews

---

## Prioritized Action Plan

### High Priority (Expected 100+ reviews recovered)

1. **ScrapingBee Stealth for Guardian** (~46 reviews)
   - Free content, just blocked by bot protection
   - Stealth proxy should work
   - Cost: ~$3.50

2. **Fix WSJ Login** (~44 reviews)
   - Debug authentication flow
   - Verify credentials
   - No additional cost

3. **Excerpt-Based Scoring Fallback** (~350+ reviews)
   - For reviews with 2+ excerpts that fail scraping
   - Lower confidence scores but better than nothing

### Medium Priority (Expected 50-100 reviews recovered)

4. **ScrapingBee Stealth for Variety/THR** (~100+ reviews)
   - Penske Media sites are heavily protected
   - Cost: ~$10
   - May still fail - test first

5. **Archive.org "Save Page Now"** (Unknown improvement)
   - Request archiving of missing URLs
   - Takes time for Archive.org to process

### Low Priority (Marginal improvements)

6. **URL Normalization for Archive.org**
   - Try www vs non-www variants
   - Small improvement expected

7. **Mobile URL Patterns**
   - Mostly redirect to main site
   - Minimal value

---

## 9. Advanced Strategies (Future Consideration)

### 9.1 News API Services
Several services aggregate news articles with full text:

| Service | Coverage | Cost | Notes |
|---------|----------|------|-------|
| NewsAPI.org | Major outlets | $449/mo | No theater-specific outlets |
| Newscatcher API | Broad | Custom | May have theater coverage |
| GDELT Project | Academic | Free | Historical, requires filtering |

**Verdict:** Unlikely to have theater-specific coverage. Not recommended for this use case.

### 9.2 Database Services
- **LexisNexis:** Has full-text archives of major publications
- **ProQuest:** Academic database with newspaper archives
- **Cost:** Expensive institutional subscriptions

**Verdict:** Overkill for this project unless scaling significantly.

### 9.3 Archive.org "Save Page Now" Integration
Archive.org offers an API to request page archiving:
```
POST https://web.archive.org/save/{url}
```

**Potential workflow:**
1. Submit missing URLs to Archive.org for archiving
2. Wait 24-48 hours for processing
3. Re-run collection with Archive.org tier

**Limitation:** Archive.org may refuse to archive paywalled content.

### 9.4 Outlet-Specific APIs

| Outlet | API Available? | Notes |
|--------|---------------|-------|
| NYTimes | Yes (Article Search API) | Requires API key, limited |
| Guardian | Yes (Open Platform) | Free tier, 200 calls/day |
| Variety | No public API | - |
| TheaterMania | No API | - |

**Guardian API potential:**
- Free tier allows 200 calls/day
- Returns full article content
- Could recover all 47 Guardian reviews
- Implementation: Add Guardian API as Tier 0 for guardian.com URLs

**Recommendation:** Implement Guardian API - low effort, high reward (47 reviews)

---

## Implementation Checklist

### High Impact (Do First)
- [x] **Implement Guardian Open Platform API** - 47 reviews, free API, high success expected
  - COMPLETED 2026-01-28: Created `scripts/fetch-guardian-reviews.js`
  - Created GitHub workflow: `.github/workflows/fetch-guardian-reviews.yml`
  - Requires GUARDIAN_API_KEY secret (free at https://open-platform.theguardian.com/access/)
  - Run: `gh workflow run "Fetch Guardian Reviews via API"`
- [ ] **Add stealth_proxy targeting for theguardian.com** - fallback if API fails
- [x] **Implement excerpt-based scoring mode** - allows scoring 350+ reviews with 2+ excerpts
  - ALREADY IMPLEMENTED: LLM scoring in `scripts/llm-scoring/index.ts` (lines 303-333)
  - Combines dtliExcerpt + bwwExcerpt + showScoreExcerpt when fullText unavailable
  - 743 reviews already scored on excerpts (356 with 2+ excerpts)
  - Created `scripts/mark-excerpt-scores.js` for tracking textSource
- [x] **Debug WSJ login** (check scripts/collect-review-texts.js loginToSite function)
  - ANALYZED 2026-01-28: NOT A BUG - see `data/audit/wsj-login-debug-findings.md`
  - WSJ is in archiveFirstSites, so Archive.org tried first (not login)
  - Actual success rate: 45% (36/80 reviews have fullText via Archive.org)
  - Login code exists and is correct, just rarely reached

### Medium Impact
- [ ] Test Variety with stealth_proxy (small batch of 5-10 first)
- [ ] Test Hollywood Reporter with stealth_proxy
- [ ] Add URL normalization for Archive.org lookups (www vs non-www)
- [ ] Track success rates per outlet after changes

### Low Impact / Future
- [ ] Investigate Archive.org "Save Page Now" API for missing URLs
- [ ] Consider LexisNexis for historical completeness (expensive)
- [ ] Monitor for new theater-specific news aggregators

---

## Appendix: Outlet Success Rate Summary

### High Success Rate (>70%)
| Outlet | Reviews | Success Rate | Best Method |
|--------|---------|--------------|-------------|
| theater-scene | 6 | 100% | Playwright |
| broadwaynews | 49 | 96% | DTLI/Playwright |
| culturesauce | 15 | 93% | Playwright |
| timeout | 73 | 88% | ScrapingBee |
| theatrely | 62 | 87% | Playwright |
| nysr | 124 | 85% | Playwright/Archive |
| nyt-theater | 46 | 85% | Playwright |
| cititour | 35 | 80% | ScrapingBee |
| thewrap | 75 | 76% | Archive |
| deadline | 60 | 73% | Archive |
| dailybeast | 47 | 72% | BrightData |
| nytimes | 108 | 72% | Archive |

### Medium Success Rate (40-70%)
| Outlet | Reviews | Success Rate | Best Method |
|--------|---------|--------------|-------------|
| vulture | 96 | 66% | Archive |
| nypost | 81 | 64% | Archive |
| theatermania | 119 | 52% | Archive |
| nydailynews | 92 | 49% | Archive |
| wsj | 79 | 44% | Mixed |
| variety | 137 | 44% | Mixed |

### Low Success Rate (<40%)
| Outlet | Reviews | Success Rate | Best Method | Notes |
|--------|---------|--------------|-------------|-------|
| hollywood-reporter | 50 | 30% | Mixed | Penske Media paywall |
| guardian | 48 | 2% | None | Free content, blocked |
| billboard | 6 | 0% | None | Few reviews |

### Key Insight: Corrected Data
After deeper analysis, some outlets have higher success rates than initially reported:
- **Variety:** 44% success (60/137), not 0% - some older reviews scraped successfully
- **WSJ:** 44% success (35/79), not 0% - subscription login works partially
- **Hollywood Reporter:** 30% success (15/50), not 0%
- **Guardian:** Only 2% success (1/48) - remains problematic despite free content
