# Extraction & Data Quality Improvement Plan

**Created:** Feb 2026
**Context:** Audit of 2,022-review corpus revealed systematic text quality and scoring issues.

## Priority 1: Text Cleaning at Source (High Impact, Low Effort)

### P1-1: Decode HTML entities at write time
**Files:** `scripts/gather-reviews.js`, `scripts/collect-review-texts.js`
**What:** Add an `cleanText()` utility that decodes HTML entities (`&#8220;` → `"`, `&hellip;` → `...`, etc.) before writing fullText to JSON files.
**Why:** Variety, EW, and other outlets deliver entity-polluted text. A clearly positive review (Maybe Happy Ending) scored 50/Mixed because the LLM parsed `&#8220;` as noise.
**Scope:** Create shared `scripts/lib/text-cleaning.js` with:
- HTML entity decoding (numeric + named)
- Whitespace normalization (collapse `\t\n` runs)
- Null-byte and control character stripping
- Import in both gather-reviews.js and collect-review-texts.js

### P1-2: Outlet-specific junk strippers
**Files:** `scripts/lib/text-cleaning.js` (new shared module)
**What:** Add per-outlet strip patterns for known junk:

| Outlet | Pattern to strip |
|--------|-----------------|
| EW | `<img>` tags, srcset attributes, video player controls, "Related Articles" sections |
| The Times (UK) | Paywall prefix up to review headline |
| BWW | "Get Access To Every Broadway Story..." paywall block |
| BroadwayNews | Site navigation menu (when JS rendering fails) |
| Variety | "Related Stories" / "Popular on Variety" interstitials, tab/newline blocks |
| Vulture/NY Mag | Newsletter signup blocks at end |
| TheaterMania | Newsletter promo at end |

**Why:** These patterns cause LLM scoring to fail (scores from garbage) or produce low-confidence results.
**Note:** `collect-review-texts.js` already has some end-of-text strippers (newsletter promos, login prompts). This extends that approach with more patterns and applies it to `gather-reviews.js` too.

### P1-3: Auto-convert explicit ratings to assignedScore
**Files:** `scripts/rebuild-all-reviews.js` or new `scripts/lib/rating-converter.js`
**What:** When a review has `originalScore` (e.g., "4/5 stars", "B+", "★★★★☆", "3.5/5"), convert directly to numeric score without relying on LLM.
**Conversion table:**

| Format | Example | Score |
|--------|---------|-------|
| X/5 stars | 4/5 | 80 |
| X/5 stars | 3.5/5 | 70 |
| Letter grade | A | 95 |
| Letter grade | B+ | 83 |
| Letter grade | B | 78 |
| Letter grade | B- | 73 |
| Letter grade | C+ | 68 |
| Star symbols | ★★★★☆ | 80 |
| X/10 | 7/10 | 70 |

**Why:** Suffs review had "4/5 stars" but LLM scored 50 from paywall text. Explicit ratings are more reliable than LLM inference.

## Priority 2: Quality Classification Gap (Medium Impact, Medium Effort)

### P2-1: Add quality classification to gather-reviews.js
**Files:** `scripts/gather-reviews.js`
**What:** After fetching fullText via web search, run the same quality classification that `collect-review-texts.js` uses: word count check, truncation signals, paywall detection, garbage patterns.
**Why:** 172 web-search reviews have `contentTier: none` — no quality signal at all. Garbage may lurk undetected.
**Approach:** Extract the quality classification logic from `collect-review-texts.js` into a shared module (`scripts/lib/text-quality.js`) and call it from both scripts.

### P2-2: URL-based dedup check
**Files:** `scripts/lib/deduplication.js` or `scripts/gather-reviews.js`
**What:** Before creating a new review file, check if the URL already exists in another file for the same show.
**Why:** Same Variety URL appeared under two critic names (Maybe Happy Ending: Christian Lewis and Peter Marks). Only outlet+critic dedup exists today.
**Scope:** Add `isUrlDuplicate(showDir, url)` check before file creation.

## Priority 3: Feedback Loop (Medium Impact, Higher Effort)

### P3-1: Auto-flag garbage from LLM confidence
**Files:** `scripts/llm-scoring/index.ts` or post-scoring audit script
**What:** When LLM scoring produces low confidence AND the reasoning contains specific signals ("website navigation content", "plot summary rather than review", "headline and byline only"), automatically set `contentTier: 'needs-rescrape'` and clear fullText.
**Why:** Currently requires manual review of low-confidence reviews. The LLM's garbage detection is reliable — ~90% accurate on "this isn't a review" judgments.
**Approach:** Add a post-scoring step that checks new low-confidence results and flags obvious garbage for re-collection.

### P3-2: BroadwayNews JS rendering wait strategy
**Files:** `scripts/collect-review-texts.js` (Playwright tier)
**What:** For BroadwayNews URLs, add a specific wait-for-selector strategy that waits for the article content div to render, rather than just `networkidle`.
**Why:** BroadwayNews uses heavy JS rendering. The scraper consistently gets site navigation instead of review content.
**Scope:** Add to the outlet-specific config in collect-review-texts.js:
```javascript
'broadwaynews.com': { waitForSelector: '.entry-content', waitTimeout: 15000 }
```

## Priority 4: Workflow Robustness (Already Partially Done)

### P4-1: Standardize parallel push pattern ✅ DONE (Feb 2026)
**Files:** `gather-reviews.yml`, `rebuild-reviews.yml` — both fixed
**What:** All parallel-safe workflows use `git checkout -- . && git clean -fd` + `-X theirs` for push retry.
**Remaining:** Apply same pattern to `collect-review-texts.yml`, `scrape-nysr.yml`, `scrape-new-aggregators.yml` if they don't already have it.

## Implementation Order

1. **P1-1 + P1-2** (text cleaning) — Highest ROI. Fixes the root cause of many scoring errors.
2. **P1-3** (rating conversion) — Quick win. Prevents LLM from overriding explicit ratings.
3. **P2-1** (quality classification in gather-reviews) — Prevents future blind spots.
4. **P2-2** (URL dedup) — Prevents duplicate reviews.
5. **P3-1** (auto-flag garbage) — Closes the feedback loop.
6. **P3-2** (BroadwayNews rendering) — Outlet-specific fix.
7. **P4-1** (remaining workflow fixes) — Incremental robustness.

## Dependencies / Overlap

- **P1-1 and P1-2** should be a single PR creating `scripts/lib/text-cleaning.js`
- **P2-1** depends on extracting quality logic from `collect-review-texts.js` into a shared module
- **P3-1** may overlap with LLM scoring improvements planned in `docs/LLM-SCORING-IMPROVEMENT-PLAN.md` (Phase 1: prefer fullText, Phase 3: multi-show detection)
- Check with other active sessions before implementing to avoid conflicts
