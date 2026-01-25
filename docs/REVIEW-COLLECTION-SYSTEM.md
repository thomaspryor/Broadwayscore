# Automated Review Collection System

## Overview

A multi-phase pipeline to collect, score, and validate critic reviews for all Broadway shows using a **dual approach**:
1. **Aggregator-based**: Scrape DTLI, Show-Score, BWW for their review lists
2. **Outlet-based**: Systematically search all known critic outlets

The **union of both approaches** ensures comprehensive coverage.

## The Problem

1. Direct web scraping gets **403 blocked** by most sites
2. Manual HTML file collection doesn't scale
3. Single aggregators miss some outlets
4. Need to extract/assign **0-100 scores** for each review
5. Must validate counts to ensure completeness

## The Solution: Dual-Approach Pipeline

### Approach 1: Aggregator Scraping
Scrape all 3 aggregators to find reviews they've indexed:
- **Did They Like It (DTLI)** - didtheylikeit.com
- **Show-Score** - show-score.com (Critic Reviews section)
- **BroadwayWorld Review Roundup** - broadwayworld.com

### Approach 2: Master Outlet Search
Systematically search all ~40 known Broadway critic outlets:
- See `scripts/config/critic-outlets.json` for master list
- Tier 1: NYT, Vulture, Variety, Time Out, THR, WaPo, Guardian, AP, WSJ, Broadway News
- Tier 2: Deadline, The Wrap, NY Daily News, NY Post, Rolling Stone, TheaterMania, etc.
- Tier 3: NY Theater, Cititour, Culture Sauce, Stage and Cinema, etc.

### Combined Output
Union of both approaches = maximum coverage

---

## Phase 1: Discovery

**Goal:** For each show, find ALL reviews by searching 3 aggregators

### Aggregator Searches (per show)

```
1. DTLI:        "[Show Name]" site:didtheylikeit.com Broadway
2. Show-Score:  "[Show Name]" site:show-score.com
3. BWW Roundup: site:broadwayworld.com "Review Roundup" "[Show Name]"
```

### Output: Review Manifest

For each show, create a list of discovered reviews:
```json
{
  "showId": "mj-2022",
  "discoveryDate": "2026-01-21",
  "aggregatorCounts": {
    "dtli": { "total": 16, "positive": 5, "mixed": 5, "negative": 6 },
    "showScore": { "outlets": ["NYT", "Vulture", "Variety", ...] },
    "bww": { "outlets": ["NYT", "Washington Post", ...] }
  },
  "reviews": [
    { "outlet": "NYT", "critic": "Jesse Green", "url": "https://...", "ratingFound": null },
    { "outlet": "Vulture", "critic": "Helen Shaw", "url": "https://...", "ratingFound": null },
    ...
  ]
}
```

---

## Phase 2: Rating Extraction

**Goal:** For each discovered review, find the actual star/letter/numeric rating

### Search Strategy (per review)

```
"[Outlet Name]" "[Show Name]" Broadway review [stars|rating|grade] [year]
```

### Rating Sources (in order of preference)

1. **Explicit rating in search results** (e.g., "4/5 stars", "B+", "Critic's Pick")
2. **WebFetch the review URL** if not blocked - parse for rating
3. **Aggregator sentiment** (DTLI thumb up/down/meh, Show-Score percentage)
4. **LLM sentiment analysis** of review snippets/quotes

### Conversion Rules (from scoring.ts)

| Format | Score |
|--------|-------|
| 5/5 stars | 100 |
| 4.5/5 | 90 |
| 4/5 | 80 |
| 3.5/5 | 70 |
| 3/5 | 60 |
| A+ | 100, A | 95, A- | 90 |
| B+ | 85, B | 80, B- | 75 |
| C+ | 70, C | 65, C- | 60 |
| Critic's Pick (NYT) | Base + 3 points (typically 88-92) |
| "Rave" / "Excellent" | 88-92 |
| "Positive" | 78-82 |
| "Mixed" | 58-65 |
| "Pan" / "Negative" | 35-45 |

### Fallback: LLM Sentiment Scoring

For reviews without explicit ratings, use the review text/quotes to assign:
- Analyze tone, language, conclusion
- Consider outlet's typical scoring patterns
- Assign score with confidence level

---

## Phase 3: Validation

**Goal:** Ensure our data matches aggregator counts

### Validation Checks

1. **Count Match:** Our review count ≈ DTLI count (±2)
2. **Sentiment Distribution:** Our positive/mixed/negative % within 5% of DTLI
3. **Tier 1 Coverage:** All major outlets present (NYT, Vulture, Variety, THR, etc.)
4. **No Duplicates:** Same outlet+critic not counted twice

### Output: Validation Report

```
=== VALIDATION REPORT: MJ The Musical ===

Review Count:
- DTLI: 16 reviews
- Our data: 16 reviews ✓

Sentiment Distribution:
- DTLI: 31% positive, 31% mixed, 38% negative
- Ours: 31% positive, 31% mixed, 38% negative ✓

Tier 1 Coverage: 6/6 ✓
- NYT ✓, Vulture ✓, Variety ✓, THR ✓, TIMEOUT ✓, WASHPOST ✓

READY FOR IMPORT
```

---

## Phase 4: Data Import

**Goal:** Write validated reviews to reviews.json

### Review Schema

```json
{
  "showId": "mj-2022",
  "outletId": "NYT",
  "outlet": "The New York Times",
  "criticName": "Jesse Green",
  "url": "https://www.nytimes.com/2022/02/01/theater/mj-musical-review.html",
  "publishDate": "2022-02-01",
  "originalRating": "Mixed",
  "assignedScore": 65,
  "bucket": "Mixed",
  "thumb": "Flat",
  "pullQuote": "Michael Jackson was such a magnet for strange stories..."
}
```

---

## Execution Strategy

### Option A: Sequential (Reliable, Slower)

Process one show at a time:
1. Run discovery searches
2. Collect ratings
3. Validate
4. Get human approval
5. Import to reviews.json
6. Move to next show

**Pros:** Can catch errors early, human-in-loop
**Cons:** Slow for 17 shows

### Option B: Batch Discovery, Sequential Import (Recommended)

1. **Discovery phase:** Search all 3 aggregators for ALL shows in parallel
2. **Rating phase:** Collect ratings for all discovered reviews
3. **Generate reports:** One validation report per show
4. **Human review:** Approve all at once or flag issues
5. **Bulk import:** Write all approved reviews

**Pros:** Faster, still has validation checkpoint
**Cons:** More data to review at once

### Option C: Fully Automated (Fast, Risky)

Run entire pipeline without human checkpoints.

**Pros:** Fastest
**Cons:** May import bad data

---

## Implementation: Claude Code Commands

### Single Show Collection

```
"Collect reviews for [Show Name].
1. Search DTLI, Show-Score, and BroadwayWorld for all reviews
2. For each review, find the actual rating (stars, letter grade, etc.)
3. Convert to 0-100 scores using our scoring rules
4. Generate a validation report
5. Wait for my approval before writing to reviews.json"
```

### Batch Collection

```
"Collect reviews for all open shows that don't have reviews yet.
Generate a summary report for each show.
Do NOT write to reviews.json until I approve."
```

---

## Show Priority List

### Recently Opened (most urgent - reviews are fresh)
1. Bug (2026) - ✓ DONE
2. Marjorie Prime (2025) - ✓ DONE
3. Two Strangers (2025) - ✓ DONE
4. Operation Mincemeat (2025)
5. Stranger Things (2024)
6. Maybe Happy Ending (2024)

### 2024 Shows (reviews still relevant)
7. The Outsiders (2024)
8. Hell's Kitchen (2024)
9. Oh, Mary! (2024)
10. The Great Gatsby (2024)

### 2022-2023 Shows
11. MJ (2022)
12. & Juliet (2022)
13. SIX (2021)
14. Harry Potter (2021)

### Long-Running Classics (historical reviews)
15. Hadestown (2019)
16. Moulin Rouge (2019)
17. Aladdin (2014)
18. Book of Mormon (2011)
19. Wicked (2003)
20. Hamilton (2015)
21. The Lion King (1997)
22. Chicago (1996)

---

## Known Challenges

### 1. Paywalled Reviews (NYT, WaPo, WSJ)
- Search results often include rating info even if full text is paywalled
- DTLI/BWW often quote the rating
- Fallback: Use aggregator sentiment classification

### 2. Reviews Without Ratings
- Many outlets (Variety, THR, Vulture) don't use star ratings
- Solution: LLM analyzes review text/quotes to assign score
- Use aggregator's thumb/sentiment as validation

### 3. Multiple Critics Per Outlet
- NY Stage Review often has 2 critics review the same show
- Solution: Include both, differentiate by critic name

### 4. Historical Shows
- Reviews from 2003 (Wicked) may be harder to find
- Solution: Search for "original Broadway review" + archives

### 5. Revivals vs Originals
- Chicago (1996 revival) vs Chicago (1975 original)
- Mamma Mia (2025 revival) vs Mamma Mia (2001 original)
- Solution: Include year in search, verify dates match our show

---

## Next Steps

1. **Test with 2 shows:** MJ (has HTML reference) + Operation Mincemeat (recent)
2. **Refine search queries** based on what works
3. **Build validation automation**
4. **Scale to all 17 shows**

---

## Success Criteria

- [ ] 15+ reviews per show (matching DTLI counts)
- [ ] All Tier 1 outlets covered
- [ ] Sentiment distribution within 5% of DTLI
- [ ] No duplicate reviews
- [ ] All scores properly converted to 0-100
- [ ] Pull quotes extracted for each review
