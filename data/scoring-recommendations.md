# Scoring System Recommendations

Based on analysis of the 2,189 scored reviews.

## Executive Summary

| Issue | Count | Severity | Recommendation |
|-------|-------|----------|----------------|
| Star ratings ignored by LLM | 23 | **HIGH** | Pre-extract star ratings before LLM scoring |
| LLM vs Aggregator thumb conflicts | 113 | MEDIUM | Spot-check biggest disagreements |
| Low-confidence scores | 66 | LOW | Acceptable - mostly short excerpts |
| Thumb-only fallbacks | 20 | LOW | Try to get LLM scores if excerpts exist |

---

## Issue 1: Star Ratings Being Ignored (HIGH PRIORITY)

**Problem:** The LLM is ignoring explicit star ratings in review text, causing major scoring errors.

**Examples of egregious mismatches:**

| Review | Stars | LLM Score | Diff |
|--------|-------|-----------|------|
| the-cottage-2023/nysr--frank-scheck.json | ★★★★☆ (4/5) | 28 | 52 pts |
| gutenberg-2023/nysr--frank-scheck.json | ★★★★★ (5/5) | 49 | 51 pts |
| our-town-2024/nysr--steven-suskin.json | ★★★★☆ (4/5) | 39 | 41 pts |
| death-becomes-her-2024/nysr--david-finkle.json | ★★★★☆ (4/5) | 40 | 40 pts |

**Root Cause:** The LLM prompt instructs it to analyze sentiment from the text, but it doesn't prioritize explicit ratings over sentiment analysis.

**Recommendation:**
1. **Pre-extract star ratings** before LLM scoring
2. If a review contains `★★★★☆` or similar pattern, **use that as the score** (4 stars = 80)
3. Only fall back to LLM sentiment analysis when no explicit rating exists

**Implementation:**
```javascript
// In scoring pipeline, check for star ratings first
const starMatch = text.match(/★+☆*/);
if (starMatch) {
  const filled = (text.match(/★/g) || []).length;
  const total = filled + (text.match(/☆/g) || []).length;
  if (total === 5) return { score: filled * 20, source: 'star-rating' };
  if (total === 4) return { score: filled * 25, source: 'star-rating' };
}
// Then fall back to LLM scoring
```

**Affected reviews:** 23 with significant mismatches, 107 total with star ratings

---

## Issue 2: Thumb Conflicts (MEDIUM PRIORITY)

**Problem:** 113 reviews where LLM score conflicts with DTLI/BWW thumb classification.

**Breakdown:**
- LLM Down, Aggregator Flat/Meh: 51 reviews (45%)
- LLM Flat, Aggregator Up: 27 reviews (24%)
- LLM Down, Aggregator Up: 10 reviews (9%)
- Other conflicts: 25 reviews (22%)

**Most affected shows:**
1. real-women-have-curves-2025: 9 conflicts
2. back-to-the-future-2023: 8 conflicts
3. the-notebook-2024: 8 conflicts
4. cabaret-2024: 6 conflicts
5. suffs-2024: 6 conflicts

**Recommendation:**
- For **LLM Down + Agg Up** (10 reviews): Manually review - likely LLM errors
- For **LLM Flat + Agg Up** (27 reviews): Spot-check a sample
- For **LLM Down + Agg Flat** (51 reviews): Acceptable range difference

**Specific reviews to manually verify:**
1. `suffs-2024/nydailynews--chris-jones.json` - LLM: 30, Agg: Up (60 pt gap!)
2. `suffs-2024/washpost--elisabeth-vincentelli.json` - LLM: 29, Agg: Up
3. `harmony-2023/nysr--sandy-macdonald.json` - Has ★★★★☆ but LLM: 50

---

## Issue 3: Low-Confidence Scores (LOW PRIORITY)

**Status:** Already handled - we accept these as `llmScore-lowconf`

**Root causes:**
- Model disagreement (>15 pts): 41 reviews (62%)
- Incomplete/truncated text: 21 reviews (32%)
- Error pages/metadata: 2 reviews (3%)
- Other: 2 reviews (3%)

**Recommendation:** No action needed. These scores are usable and preferable to having no score.

---

## Issue 4: Thumb-Only Fallbacks (LOW PRIORITY)

**Status:** 20 reviews using thumb-derived scores (Up=78, Flat=58, Down=38)

**Why they exist:** LLM scoring failed or was never run on these reviews.

**Recommendation:**
- Run LLM scoring on these 20 reviews
- Most have excerpts that could be scored

```bash
# Identify and re-score thumb-only reviews
node scripts/llm-scoring/index.ts --show=<show-id> --rescore
```

---

## Implementation Priority

### Immediate (High Impact)
1. **Fix star rating extraction** - Create a pre-scoring step that extracts explicit ratings
2. **Re-score the 23 star-rating mismatches** using extracted ratings

### Short-term (Medium Impact)
3. **Manually verify 10 "LLM Down + Agg Up" reviews** - These are likely errors
4. **Run LLM scoring on 20 thumb-only reviews**

### Long-term (Nice to Have)
5. **Investigate shows with many conflicts** (real-women-have-curves, back-to-the-future)
6. **Add star rating detection to the scoring prompt** as a hint

---

## Code Changes Needed

### 1. Star Rating Pre-Extraction

Add to `scripts/llm-scoring/index.ts`:

```typescript
function extractStarRating(text: string): number | null {
  // Match patterns like ★★★★☆ or ★★★☆☆
  const match = text.match(/★+☆*/);
  if (!match) return null;

  const filled = (match[0].match(/★/g) || []).length;
  const empty = (match[0].match(/☆/g) || []).length;
  const total = filled + empty;

  if (total === 5) return filled * 20; // 5-star scale
  if (total === 4) return filled * 25; // 4-star scale
  if (total === 10) return filled * 10; // 10-star scale

  return null; // Unknown scale
}
```

### 2. Modified Scoring Pipeline

```typescript
async function scoreReview(reviewFile: ReviewTextFile) {
  const text = getScorableText(reviewFile);

  // Priority 1: Extract explicit star rating
  const starScore = extractStarRating(text);
  if (starScore !== null) {
    return {
      score: starScore,
      source: 'star-rating',
      confidence: 'high'
    };
  }

  // Priority 2: LLM ensemble scoring
  return await llmScore(text);
}
```

---

## Metrics to Track

After implementing fixes:

| Metric | Current | Target |
|--------|---------|--------|
| Star rating accuracy | 66% (44/67 within 15 pts) | 100% |
| Thumb conflicts | 113 (5.2%) | <50 (2.3%) |
| Low confidence | 66 (3.0%) | Same (acceptable) |
| Thumb-only fallbacks | 20 (0.9%) | 0 |
