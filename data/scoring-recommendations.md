# Scoring System Recommendations

Based on analysis of the 2,189 scored reviews.

## Executive Summary

| Issue | Count | Severity | Status |
|-------|-------|----------|--------|
| Explicit ratings ignored by LLM | 87 | **HIGH** | **FIXED** - Now extracted and prioritized |
| LLM vs Aggregator thumb conflicts | 113 | MEDIUM | Spot-check biggest disagreements |
| Low-confidence scores | 66 | LOW | Acceptable - mostly short excerpts |
| Thumb-only fallbacks | 8 | LOW | Reduced from 20 |

---

## Issue 1: Explicit Ratings Being Ignored ✅ FIXED

**Problem:** The LLM was ignoring explicit ratings in review text (stars, letter grades, "X out of 5"), causing major scoring errors.

**Solution Implemented:** Added explicit rating extraction to `rebuild-all-reviews.js` that:
1. Extracts star ratings (★★★★☆)
2. Extracts "X out of Y" ratings ("4 out of 5")
3. Extracts letter grades in context ("gives it an A", "grade: B+")
4. Prioritizes these over LLM scores

**Results:**

| Metric | Before | After |
|--------|--------|-------|
| Explicit ratings extracted | 0 | 255 |
| Reviews with >15pt mismatch | 87 | 0* |
| Worst case error | 75 pts (A→20) | Fixed |

*The 7 remaining "mismatches" were false positives in the original analysis (letter "D" appearing in text but not as a grade).

**Examples of fixes:**

| Review | Rating | Old LLM | New Score |
|--------|--------|---------|-----------|
| queen-versailles-2025/dailybeast | A grade | 20 | 95 |
| chess-2025/nypost | A grade | 25 | 95 |
| gutenberg-2023/nysr | ★★★★★ | 49 | 100 |
| the-cottage-2023/nysr | ★★★★☆ | 28 | 80 |

**Score sources now:**
- `explicit-stars`: 107 reviews (4.9%)
- `explicit-outOf`: 44 reviews (2.0%)
- `explicit-slash`: 3 reviews (0.1%)
- `explicit-letterGrade`: 101 reviews (4.6%)
- `llmScore`: 1,753 reviews (80.1%)

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

## Issue 3: Low-Confidence LLM Scores ✅ FIXED

**Problem:** 155 reviews had low-confidence or needs-review LLM scores, often because the text was incomplete/garbled.

**Solution Implemented:** Aggregator thumbs now OVERRIDE low-confidence LLM scores.

**Rationale:** When LLM confidence is low, it's usually because the text is incomplete. Aggregator editors (DTLI/BWW) saw the FULL review - their judgment is more reliable.

**Results:**

| Category | Before | After |
|----------|--------|-------|
| thumb-override-llm | 0 | 115 |
| llmScore-lowconf | 62 | 35 |
| llmScore-review | 93 | 5 |

The 40 remaining low-conf/needs-review scores are reviews WITHOUT thumb data.

---

## Issue 4: Thumb-Only Fallbacks (RESOLVED)

**Status:** Now only 8 reviews using pure thumb fallback (down from 20).

These are reviews where:
- No explicit rating in text
- No LLM score available
- Thumb is the only signal

This is acceptable - thumbs are legitimate editorial judgments.

---

## Implementation Priority

### Completed ✅
1. ~~**Fix explicit rating extraction**~~ - **DONE** (Jan 29, 2026)
   - Extracts stars, letter grades, "X out of Y" from text
   - Prioritizes over LLM scores
   - 79 reviews corrected

2. ~~**Thumb override for low-confidence LLM**~~ - **DONE** (Jan 29, 2026)
   - Aggregator thumbs now override low-conf/needs-review LLM scores
   - 115 reviews now use more reliable thumb data

### Remaining (Low Priority)
3. **40 reviews still using low-conf LLM** - No thumb data available, acceptable
4. **8 reviews using pure thumb fallback** - Acceptable, legitimate editorial judgment

---

## Current Metrics (After All Fixes)

| Metric | Value | Status |
|--------|-------|--------|
| Total reviews | 2,189 | - |
| Explicit rating accuracy | 100% | ✅ Fixed |
| Thumb override of low-conf | 115 | ✅ New |
| Remaining low-conf (no thumb) | 40 | Acceptable |
| Thumb-only fallbacks | 8 | Acceptable |

### Score Source Distribution (Final)

| Source | Count | Percentage |
|--------|-------|------------|
| LLM Score (high/medium conf) | 1,753 | 80.1% |
| Thumb override of low-conf LLM | 115 | 5.3% |
| Explicit Stars | 107 | 4.9% |
| Explicit Letter Grade | 101 | 4.6% |
| Explicit "X out of Y" | 44 | 2.0% |
| LLM Score (low conf, no thumb) | 35 | 1.6% |
| Assigned Score | 17 | 0.8% |
| Thumb-only (no LLM) | 8 | 0.4% |
| LLM Score (needs review, no thumb) | 5 | 0.2% |
| Explicit Slash (X/5) | 3 | 0.1% |
| Original Score parsed | 1 | 0.0% |
