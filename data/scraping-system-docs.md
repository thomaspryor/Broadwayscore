# Review Text Scraping System Documentation

## Overview

This document describes the multi-tier scraping system for collecting full review text from critic reviews.

## Current Coverage (January 2026)

| Metric | Count |
|--------|-------|
| Total review files | 2,195 |
| Has full text (100+ chars) | 1,629 (74%) |
| Excerpt only | 566 (26%) |
| Shows covered | 72 |

## Scraping Tiers (in order of attempt)

### Tier 0: Archive.org Wayback Machine
- **Success Rate:** ~11% (best performer for paywalled sites)
- **Cost:** Free
- **When Used:** First attempt for known paywalled sites
- **Advantages:**
  - No paywall detection
  - Historical snapshots available
  - No bot detection
- **Limitations:**
  - Not all pages archived
  - May have outdated content

### Tier 1: Playwright with Stealth Plugin
- **Success Rate:** ~7%
- **Cost:** Free (compute time only)
- **When Used:** After Archive.org fails, or first for free sites
- **Advantages:**
  - Full browser rendering
  - JavaScript execution
  - Login support for subscribed sites
- **Limitations:**
  - CAPTCHA detection on many sites
  - Bot detection blocking
  - Slow (browser startup)

### Tier 2: ScrapingBee API
- **Success Rate:** ~4%
- **Cost:** 1-75 credits/request
- **When Used:** After Playwright fails
- **Options:**
  - Standard: 1 credit
  - Premium proxy: 10 credits
  - Stealth proxy: 75 credits (best CAPTCHA bypass)
- **Advantages:**
  - Rotating proxies
  - JavaScript rendering
  - Premium bypasses many blocks
- **Limitations:**
  - Cost per request
  - Still blocked by some sites

### Tier 3: Bright Data Web Unlocker
- **Success Rate:** ~4%
- **Cost:** Per-request billing
- **When Used:** Last resort
- **Advantages:**
  - Residential proxies
  - Automatic CAPTCHA solving
- **Limitations:**
  - Expensive
  - Some sites still block

## Paywalled Sites with Credentials

The following sites have subscription credentials configured:

| Site | Tier | Credential Secrets | Login Implemented |
|------|------|-------------------|-------------------|
| NYT | 1 | `NYT_EMAIL`, `NYTIMES_PASSWORD` | Yes |
| Vulture/NY Mag | 1 | `VULTURE_EMAIL`, `VULTURE_PASSWORD` | Yes |
| New Yorker | 1 | (uses Vulture) | Yes |
| Washington Post | 1 | `WAPO_EMAIL`, `WASHPOST_PASSWORD` | Yes |
| Wall Street Journal | 1 | `WSJ_EMAIL`, `WSJ_PASSWORD` | Yes |

**Note:** Login success rate is limited (~6.7%) due to sophisticated bot detection.

## Outlet Priority for Scraping

### Priority 1: Free Tier 1 Outlets (Highest Impact)
- The Guardian (FREE)
- Associated Press (FREE)
- Hollywood Reporter (metered)
- Variety (metered)
- Deadline (FREE but heavy bot protection)

### Priority 2: Paywalled with Credentials
- New York Times
- Wall Street Journal
- Vulture/NY Magazine
- Washington Post

### Priority 3: Free Tier 2 Outlets
- TheaterMania (FREE)
- Observer (FREE)
- New York Stage Review (FREE)
- The Wrap (FREE)
- AP (FREE)

### Priority 4: Heavily Protected Sites
- Time Out New York (soft paywall + CAPTCHA)
- NY Daily News (soft paywall)
- Broadway News (many 404s)

## Recommended Scraping Strategy

### For New Shows
1. Gather reviews from aggregators (Show Score, DTLI, BWW)
2. Try Archive.org first for all URLs
3. Try Playwright for free outlets
4. Try ScrapingBee/BrightData for remaining
5. Fall back to excerpt-based LLM scoring

### For Historical Backfill
1. Prioritize Tier 1 outlets
2. Use Archive.org heavily (historical snapshots exist)
3. Accept excerpt-only for hard-paywalled sites without credentials

## GitHub Workflows

### `collect-review-texts.yml`
- **Trigger:** Manual
- **Options:**
  - `show_filter`: Process specific show
  - `archive_first`: Try Archive.org first (default: true)
  - `stealth_proxy`: Use expensive but effective ScrapingBee stealth
  - `parallel`: Run by tier in parallel

### Trigger Examples
```bash
# Collect reviews for specific show
gh workflow run "Collect Review Texts" --field show_filter=hamilton-2015

# Aggressive collection with stealth proxy
gh workflow run "Collect Review Texts" --field stealth_proxy=true --field max_reviews=100

# Parallel by tier
gh workflow run "Collect Review Texts" --field parallel=true
```

## Content Quality Detection

The system detects garbage content including:
- Paywall prompts ("subscribe to continue")
- Ad blocker messages
- 404/error pages
- Login required messages
- Cookie consent overlays
- Newsletter signup forms
- Copyright-only pages

Garbage is logged and skipped. Reviews with garbage fullText but available excerpts are scored using excerpts.

## Outlet ID Normalization

All outlet IDs are normalized to lowercase to prevent duplicates:
- `WSJ` → `wsj`
- `TIMEOUT` → `timeout`
- `The New York Times` → `nytimes`

See `scripts/lib/review-normalization.js` for the full mapping.

## Files

| File | Purpose |
|------|---------|
| `scripts/collect-review-texts.js` | Main collection script |
| `scripts/lib/content-quality.js` | Garbage detection |
| `scripts/lib/review-normalization.js` | Outlet/critic normalization |
| `scripts/scrape-priority-reviews.js` | Priority list generator |
| `scripts/fix-garbage-reviews.js` | Clean up garbage fullText |
| `data/review-texts/{showId}/*.json` | Review data files |
| `data/archives/reviews/{showId}/*.html` | Archived HTML snapshots |

## Metrics to Track

1. **Coverage by Tier:** % of Tier 1/2/3 reviews with full text
2. **Success by Method:** Which scraping tier works for each outlet
3. **Garbage Rate:** % of reviews with garbage content
4. **Excerpt Quality:** Length and completeness of aggregator excerpts

## Future Improvements

1. **Systematic Archive.org:** Run Archive.org for ALL URLs, not just paywalled
2. **Outlet-specific strategies:** Track which method works for each outlet
3. **Retry scheduling:** Automatically retry failed URLs after cooldown
4. **URL validation:** Check for 404s before attempting scrape
5. **Better login handling:** Refresh cookies, handle 2FA
