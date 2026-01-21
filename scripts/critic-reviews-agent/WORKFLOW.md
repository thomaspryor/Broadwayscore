# Critic Reviews Collection Workflow

## The Reality

Direct web scraping (HTTP requests to review sites) gets **403 blocked**.
Search APIs require paid API keys.
**Claude Code's WebSearch capability WORKS** and is the recommended approach.

## Step-by-Step Workflow

### 1. Get the Review Count from DTLI

First, check Did They Like It for the target show to know how many reviews to find:
```
Search: "[Show Name] Did They Like It"
```
Note the breakdown: X positive, Y mixed, Z negative = Total reviews.

### 2. Search for the Show's Review Roundup

```
Search: "[Show Name] Broadway review roundup 2026"
```

This typically surfaces BroadwayWorld's review roundup which lists all major reviews.

### 3. For Each Major Outlet, Get the Actual Rating

For each outlet in our Tier 1 & 2 list, search specifically:
```
Search: "[Outlet Name] [Show Name] Broadway review stars rating 2026"
```

Extract:
- **Star rating**: "4/5 stars", "3 out of 5", etc.
- **Letter grade**: "B+", "A-", etc.
- **Sentiment**: If no rating, determine from pull quotes

### 4. Convert Ratings to 0-100 Scale

| Rating | Score |
|--------|-------|
| 5/5 stars | 100 |
| 4.5/5 | 90 |
| 4/5 | 80 |
| 3.5/5 | 70 |
| 3/5 | 60 |
| 2.5/5 | 50 |
| 2/5 | 40 |
| A+ | 98 |
| A | 95 |
| A- | 91 |
| B+ | 87 |
| B | 83 |
| B- | 79 |
| C+ | 75 |
| C | 71 |
| "Rave" / "Excellent" | 88-92 |
| "Positive" / "Favorable" | 78-82 |
| "Mixed" / "Uneven" | 58-65 |
| "Pan" / "Negative" | 35-45 |

### 5. Score → Bucket Classification

| Score | Bucket | Thumb |
|-------|--------|-------|
| 85+ | Rave | Up |
| 70-84 | Positive | Up |
| 50-69 | Mixed | Flat |
| <50 | Pan | Down |

### 6. Validate Against DTLI

After collecting all reviews:
- **Count match**: Should match or be close to DTLI total
- **Mixed count**: Should match DTLI's mixed count exactly
- **% Positive**: Should be within 5% of DTLI

If there's a mismatch, re-check reviews near the 70 threshold (they might be misclassified).

## Core Outlets Checklist (18 outlets matching DTLI)

### Tier 1 (always check)
- [ ] The New York Times (NYT)
- [ ] The Washington Post (WASHPOST)
- [ ] Variety (VARIETY)
- [ ] Vulture (VULT)
- [ ] Time Out New York (TIMEOUTNY)
- [ ] The Hollywood Reporter (THR)

### Tier 2 (always check)
- [ ] Deadline (DEADLINE)
- [ ] IndieWire (INDIEWIRE)
- [ ] New York Daily News (NYDN)
- [ ] New York Post (NYP)
- [ ] The Daily Beast (TDB)
- [ ] Chicago Tribune (CHTRIB)
- [ ] TheaterMania (TMAN)
- [ ] New York Stage Review (NYSR) - may have 2 critics
- [ ] New York Theatre Guide (NYTG)
- [ ] New York Theater (NYTHTR)

### Tier 3 (optional, for completeness)
- [ ] amNewYork (AMNY)
- [ ] Culture Sauce (CSCE)
- [ ] Front Mezz Junkies (FRONTMEZZ)

## Example: Collecting Reviews for "Hamilton"

```
Step 1: Search "Hamilton Broadway Did They Like It"
Result: 20 reviews - 18 positive, 2 mixed

Step 2: Search "Hamilton Broadway review roundup"
Result: BroadwayWorld lists all major reviews

Step 3: For each outlet:
Search "New York Times Hamilton Broadway review"
→ Ben Brantley, Critic's Pick = Rave, 90

Search "Vulture Hamilton Broadway review stars"
→ No stars given, but effusive praise = Rave, 88

Search "Time Out Hamilton review stars rating"
→ 5/5 stars = 100

... continue for all outlets

Step 4: Validate
Our count: 20 reviews, 18 positive, 2 mixed
DTLI count: 20 reviews, 18 positive, 2 mixed ✓
```

## Common Pitfalls

1. **Guessing scores from snippets**: Always search for the actual star/letter rating
2. **Missing dual critics**: NY Stage Review often has 2 different critics review the same show
3. **Tier 3 inflation**: Small blogs (Jitney, etc.) can skew averages with extreme scores
4. **Threshold errors**: A 3/5 is Mixed (60), not Positive (75)

## Quick Validation Script

After entering data, run:
```bash
node -e '
const r = require("./data/reviews.json").reviews;
const show = "SHOW_ID_HERE";
const s = r.filter(x => x.showId === show);
const mixed = s.filter(x => x.bucket === "Mixed").length;
const pos = s.filter(x => x.bucket === "Positive" || x.bucket === "Rave").length;
const avg = s.reduce((a,b) => a + b.assignedScore, 0) / s.length;
console.log("Reviews:", s.length, "| Positive:", pos, "| Mixed:", mixed, "| Avg:", avg.toFixed(1));
'
```
