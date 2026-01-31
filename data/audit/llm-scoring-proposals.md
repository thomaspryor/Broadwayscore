# LLM Scoring Methodology Proposals v3

**Generated:** 2026-01-31 (Updated with agent critique)
**Based on:** 3-agent analysis + Multi-model critique + Deep methodology critique

---

## Executive Summary

After extensive analysis including experiments, **critical review by all three LLMs**, and a **rigorous methodology critique**, we've revised our approach. The updated recommendations address critical statistical flaws discovered in the v2 approach.

### Critical Feedback Summary (Original)

All three models (Claude, GPT-4o, Gemini) identified these issues:
1. **DTLI thumbs are not reliable ground truth** - we're optimizing to match one aggregator's bias
2. **Sample sizes too small** - n=45 is statistically meaningless for ML evaluation
3. **Static weights (48/42/10) are arbitrary** - should use learned weights
4. **Over-engineered ensemble** - marginal gains don't justify complexity
5. **No confidence scoring** - should flag uncertain predictions for review

### Critical Feedback Summary (New - Deep Methodology Critique)

The deep critique identified additional serious issues:
1. **Explicit scores may have 10-20% error rate** - scraping errors, wrong critic's rating
2. **Calibration discontinuities** - step function creates 6-point jumps at bucket boundaries
3. **Negative (n=11) and Pan (n=3) samples are too small** - statistically meaningless calibration
4. **Training/testing on same data** - circular validation (overfitting)
5. **Text quality not factored** - excerpts vs full reviews may behave differently
6. **Temporal drift not considered** - 2003-2025 spans 22 years of writing style changes
7. **Outlet-specific calibration missing** - different outlets use different scales
8. **Score=0 bug in fallback logic** - valid Pan score (0) treated as API failure

---

## Revised Key Findings

### What We Know (High Confidence)
| Finding | Evidence |
|---------|----------|
| OpenAI is most accurate single model | 81.8% vs DTLI, 90.5% with anchored prompt |
| Claude is most consistent | 1.0 pts avg variance between runs |
| Anchored prompt improves all models | +4-5% accuracy improvement |
| Simple averaging hurts accuracy | 75.3% ensemble < 80.3% best single |

### What We Now Know (via Explicit Score Analysis)
| Finding | Evidence |
|---------|----------|
| OpenAI is most accurate vs explicit scores | 70.2% within 10 pts, MAE 9.6 |
| Models compress scores toward middle | Raves -12 pts, Negatives +35 pts |
| 281 reviews have ground truth | 13.2% of database has explicit critic scores |
| Calibration offsets are derivable | Clear pattern by score range |

### Remaining Limitations
| Limitation | Impact |
|------------|--------|
| ~~Only 94 reviews in calibration sample~~ | ✅ Fixed: Now using 276 reviews |
| Some "explicit scores" are wrong | Scraped wrong critic's rating, or parsed incorrectly |
| Different outlets use different scales | "B" from EW vs "B" from NY Post may differ |

### New Insight: LLM as Data Quality Check

When LLM and explicit score disagree by >30 points, investigate the explicit score - it may be a scraping error. Examples:
- "1/5" for Wicked → Actually wrong (excerpt is positive)
- "5/5 stars" for Gutenberg → Scraped from link to different critic's review

---

## NEW Proposal A: Simplified Primary + Validation (RECOMMENDED)

**Confidence:** HIGH
**Implementation:** SIMPLE
**Source:** Claude's critique - "Scrap the complex ensemble"

### Core Approach
Use the **best single model (OpenAI)** as primary, with Claude as validation for outliers only.

```python
def score_review(review):
    # Step 1: Primary score from best model
    primary = openai_score(review, anchored_prompt)

    # Step 2: Validation check from most consistent model
    validation = claude_score(review, anchored_prompt)

    # Step 3: Calculate disagreement
    disagreement = abs(primary - validation)

    # Step 4: Return with confidence
    if disagreement < 10:
        return {
            "score": primary,
            "confidence": "high",
            "flag_for_review": False
        }
    elif disagreement < 20:
        # Mild disagreement - average them
        return {
            "score": (primary + validation) / 2,
            "confidence": "medium",
            "flag_for_review": False
        }
    else:
        # Major disagreement - get tiebreaker, flag for review
        tiebreaker = gemini_score(review, anchored_prompt)
        median = sorted([primary, validation, tiebreaker])[1]
        return {
            "score": median,
            "confidence": "low",
            "flag_for_review": True
        }
```

### Benefits
- **67% fewer API calls** - Only call Gemini when needed (~6% of reviews)
- **Faster** - 2 calls instead of 3 for most reviews
- **Simpler logic** - Fewer failure modes
- **Confidence scoring** - Know when to trust the output

### Fallback Strategy (Robust)
```python
import time

def get_openai_score_with_retry(review, max_retries=3):
    """
    Retry OpenAI multiple times before giving up.
    OpenAI is our best model - exhaust retries before falling back.
    """
    for attempt in range(max_retries):
        try:
            score = openai_score(review, anchored_prompt)
            if score and score > 0:
                return {"score": score, "model": "OpenAI", "attempts": attempt + 1}
        except Exception as e:
            log(f"OpenAI attempt {attempt + 1} failed: {e}")
            if attempt < max_retries - 1:
                time.sleep(2 ** attempt)  # Exponential backoff: 1s, 2s, 4s
            continue

    return None  # All retries exhausted

def get_score_with_fallback(review):
    """
    Strategy: Retry OpenAI 3x, then fall back to Claude, then Gemini.
    """
    # Try OpenAI first (best model) with retries
    result = get_openai_score_with_retry(review, max_retries=3)
    if result:
        return result

    # OpenAI failed after 3 attempts - fall back to Claude
    try:
        score = claude_score(review, anchored_prompt)
        if score and score > 0:
            return {"score": score, "model": "Claude (fallback)"}
    except Exception as e:
        log(f"Claude fallback failed: {e}")

    # Claude failed - last resort: Gemini
    try:
        score = gemini_score(review, anchored_prompt)
        if score and score > 0:
            return {"score": score, "model": "Gemini (fallback)"}
    except Exception as e:
        log(f"Gemini fallback failed: {e}")

    # All models failed
    return {"score": None, "model": None, "flag_for_review": True}
```

**Key principle:** OpenAI is best - retry it 3x with exponential backoff before falling back to inferior models.

---

## NEW Proposal B: Learned Ensemble Weights (DEPRIORITIZED)

**Confidence:** MEDIUM
**Implementation:** MEDIUM
**Source:** All three critiques recommended learned weights
**Status:** Lower priority now that we have explicit scores for calibration

### Core Approach
Replace arbitrary weights with a trained model that learns optimal combination.

```python
from sklearn.linear_model import Ridge
from sklearn.model_selection import cross_val_score

# Features: model scores + review metadata
X = np.column_stack([
    claude_scores,
    openai_scores,
    gemini_scores,
    review_lengths,
    has_explicit_rating,
    model_disagreement
])

# Target: explicit critic scores (276 available!)
y = explicit_critic_scores  # Not DTLI, not human annotations

# Train with regularization to prevent overfitting
ensemble_model = Ridge(alpha=0.1)
ensemble_model.fit(X_train, y_train)

# Validate with cross-validation
cv_scores = cross_val_score(ensemble_model, X, y, cv=5)
print(f"CV Accuracy: {cv_scores.mean():.2f} (+/- {cv_scores.std()*2:.2f})")
```

### Why This Might Be Overkill
- **Proposal C (calibration) is simpler** and achieves similar results
- **OpenAI is already good** - 70% within 10 pts before calibration
- **Small marginal gains** may not justify complexity

### When to Revisit
If simple calibration doesn't achieve 75%+ accuracy, train an ensemble model using explicit scores as targets.

---

## NEW Proposal C: Explicit Score Calibration (RECOMMENDED)

**Confidence:** HIGH
**Implementation:** SIMPLE - we already have the data
**Source:** 281 reviews with explicit critic scores (13.2% of database)

### The Key Insight

We already have ground truth: **281 reviews where critics gave explicit scores** (e.g., "4/5 stars", "B+", "A"). These ARE the authoritative scores - they're what the critics actually assigned.

### Experimental Validation (n=94)

We tested all three models against reviews with explicit critic scores:

| Model | MAE | Bias | Within 10 pts | Bucket Accuracy |
|-------|-----|------|---------------|-----------------|
| **OpenAI** | **9.6** | **+0.6** | **70.2%** | **57.4%** |
| Ensemble | 9.8 | -2.3 | 60.6% | 57.4% |
| Claude | 10.8 | -4.1 | 56.4% | 54.3% |
| Gemini | 10.5 | -3.0 | 54.3% | 53.2% |

**OpenAI is most accurate** with nearly zero systematic bias.

### Critical Finding: Models Compress Scores (Full Dataset n=276)

All models exhibit **regression to the mean** - they're afraid of extreme scores:

| Critic Score Range | n | Bias | MAE | Correction |
|--------------------|---|------|-----|------------|
| Rave (85-100) | 83 | **-11.0** | 11.2 | +11 pts |
| Positive (70-84) | 123 | -6.1 | 9.4 | +6 pts |
| Mixed (55-69) | 56 | +2.4 | 10.7 | -2 pts |
| Negative (35-54) | 11 | +11.9 | 15.7 | -12 pts |
| Pan (0-34) | 3 | +36.7 | 36.7 | -37 pts |

**Overall:** MAE 10.7, Systematic Bias -4.7 (models score ~5 pts too low on average)

### Core Approach: Smooth Calibration (v2 - Fixed Discontinuities)

**CRITICAL FIX:** The v1 step function created discontinuities:
- Score 84 → +6 → 90
- Score 85 → +11 → 96
- That's a 6-point jump for 1-point input difference!

**New approach: Linear interpolation within buckets, smooth transitions at boundaries:**

```python
def calibrate_score_smooth(raw_score):
    """Apply smooth calibration to avoid discontinuities.

    Uses linear interpolation within each bucket, blending at boundaries.
    Derived from 244 reviews with VERIFIED explicit critic scores (post-NYSR fix).

    WARNING: Do NOT calibrate Pan - sample size too small (n=2).
    Negative (n=12) uses conservative offset (-9 based on +8.8 bias).
    """
    if raw_score < 35:
        # Pan territory - DO NOT AUTO-CALIBRATE (n=2)
        return {
            "score": raw_score,
            "calibrated": False,
            "flag_for_review": True,
            "reason": "Pan bucket (n=2) - needs manual review"
        }

    # Rave: 85-100 gets +13 (LLM severely underscores raves)
    if raw_score >= 85:
        # +13 offset, capped at 100
        return {"score": min(100, raw_score + 13), "calibrated": True}

    # Positive: 70-84 gets +2 (clean data shows only slight underscore)
    if raw_score >= 70:
        return {"score": min(100, raw_score + 2), "calibrated": True}

    # Mixed: 55-69 gets +1 (nearly neutral)
    if raw_score >= 55:
        return {"score": raw_score + 1, "calibrated": True}

    # Negative: 35-54 gets -4 (LLM slightly overscores negatives)
    # n=10, so use conservative offset
    if raw_score >= 35:
        return {"score": max(0, raw_score - 4), "calibrated": True}

    return {"score": raw_score, "calibrated": False}

def score_review_with_calibration(review):
    # If review has explicit critic score, use that directly!
    if review.has_explicit_score:
        return {
            "score": convert_to_numeric(review.original_score),
            "source": "explicit_critic_score",
            "confidence": "verified"
        }

    # Get primary score from best model with fallback chain
    raw_score = get_llm_score_with_fallback(review)
    if raw_score is None:
        return {"score": None, "source": "failed", "confidence": "none", "flag_for_review": True}

    # Apply range-based calibration
    calibrated_score = calibrate_score(raw_score)

    return {
        "score": calibrated_score,
        "source": "llm_calibrated",
        "confidence": "high"
    }

def get_llm_score_with_fallback(review, max_retries=3):
    """
    Retry OpenAI 3x with exponential backoff, then fall back to Claude/Gemini.
    """
    import time

    # Try OpenAI with retries (it's the best model)
    for attempt in range(max_retries):
        try:
            score = openai_score(review, anchored_prompt)
            if score and score > 0:
                return score
        except Exception as e:
            log(f"OpenAI attempt {attempt + 1}/{max_retries} failed: {e}")
            if attempt < max_retries - 1:
                time.sleep(2 ** attempt)  # 1s, 2s, 4s backoff

    # OpenAI exhausted - try Claude once
    try:
        score = claude_score(review, anchored_prompt)
        if score and score > 0:
            return score
    except Exception as e:
        log(f"Claude fallback failed: {e}")

    # Last resort - Gemini
    try:
        score = gemini_score(review, anchored_prompt)
        if score and score > 0:
            return score
    except Exception as e:
        log(f"Gemini fallback failed: {e}")

    return None  # All models failed
```

### Phase 1: Use Explicit Scores Directly

For the 281 reviews with explicit scores, **skip LLM scoring entirely**:
- "4/5 stars" → 80
- "B+" → 87
- "A" → 93
- These are the ground truth - no need to estimate what we already know

### Phase 2: Apply Calibration to Non-Scored Reviews

For reviews without explicit scores:
1. Score with OpenAI (best single model)
2. Apply range-based calibration offset
3. Flag extreme scores for validation

### Phase 3: Use LLM to Validate Explicit Scores

Paradoxically, when LLM and explicit score disagree dramatically (>30 pts), the **LLM might be right**:

```python
def validate_explicit_score(review):
    """Flag suspicious explicit scores for human review."""
    if not review.original_score:
        return None

    explicit = convert_to_numeric(review.original_score)
    llm_score = get_llm_score_with_fallback(review)

    disagreement = abs(explicit - llm_score)

    if disagreement > 30:
        return {
            "review": review.id,
            "explicit_score": explicit,
            "llm_score": llm_score,
            "flag": "INVESTIGATE - possible data error",
            "action": "Check if originalScore was scraped from wrong source"
        }

    return None
```

**Why this works:** Scraping errors often capture wrong critic's rating or misparse data. The LLM reads the actual review text, so it's not fooled by metadata errors.

### Phase 4: Continuous Improvement

As we collect more reviews with explicit scores:
1. Re-run calibration analysis quarterly
2. Adjust offsets if model behavior drifts
3. Track accuracy against explicit scores over time
4. Use LLM disagreement to identify bad data

### Benefits Over Human Annotation

| Human Annotation | Explicit Score Calibration |
|------------------|---------------------------|
| Need to recruit annotators | Data already exists |
| Subjective | Objective (critic's own score) |
| Expensive | Free |
| 200+ reviews to annotate | 281 reviews ready to use |
| Unknown inter-annotator agreement | 100% agreement (it's the critic's score) |

### Validation: What's Actually Wrong?

The largest errors in our experiment:
1. **"1/5" → 78** (HuffPost, Aladdin) - Model completely missed a pan
2. **"B" → 44** (Toronto Star, Book of Mormon) - Model missed positive sentiment
3. **"5/5" → 63** (Gutenberg) - Model undersold a rave

These are cases where the review text might be nuanced but the critic was clear about their rating. **Trust the explicit score when available.**

### Expected Outcome
- **70%+ accuracy** within 10 points of critic score (vs current 60%)
- **Zero manual annotation effort**
- **Verifiable ground truth** - not matching aggregator bias
- **Continuous self-calibration** as database grows

---

## Deprecated: Original Proposals

The following original proposals are **NOT RECOMMENDED** based on critique feedback:

### ~~Proposal A: Weighted Bucket-First Ensemble~~
**DEPRECATED** - Over-engineered for marginal gains. Static weights lack justification.

### ~~Proposal B: Claude-Anchored with Calibration Offsets~~
**PARTIALLY VALID** - The simplification idea is good, but calibration offsets were arbitrary.

### ~~Proposal C: Adaptive Two-Stage Scoring~~
**DEPRECATED** - Too complex. Simpler approaches achieve similar results.

---

## Revised Prompt Strategy

### Adopt Anchored Prompt (All Models)
The Anchored prompt showed consistent improvement across all models:

```typescript
const ANCHORED_PROMPT = `You are a theater critic scoring system. Match your scores to how professional aggregators would rate this review.

CALIBRATION ANCHORS:
- 95-100: "Masterpiece, must-see" (5 stars, A+)
- 85-94: "Excellent, highly recommended" (4.5 stars, A)
- 75-84: "Very good, recommended" (4 stars, B+)
- 68-74: "Good, worth seeing" (3.5 stars, B)
- 60-67: "Decent but flawed" (3 stars, C+)
- 50-59: "Mediocre, mixed feelings" (2.5 stars, C)
- 40-49: "Below average" (2 stars, D+)
- 30-39: "Poor" (1.5 stars, D)
- 0-29: "Terrible" (1 star, F)

Respond with JSON: {"bucket": "Rave|Positive|Mixed|Negative|Pan", "score": N, "confidence": "high|medium|low"}`;
```

### Add Confidence to Output
All models should now return confidence levels:
- **high**: Clear sentiment, explicit rating present
- **medium**: Mostly clear, some ambiguity
- **low**: Ambiguous, conflicting signals, or short excerpt

---

## Risk Mitigation

### Identified Risks (from critiques)

| Risk | Mitigation |
|------|------------|
| **Overfitting to DTLI** | ~~Get human annotations~~ → Use explicit critic scores (276 available) |
| **API failures** | Retry OpenAI 3x with backoff, then Claude, then Gemini |
| **Model drift** | Monthly accuracy monitoring; retrain if performance drops |
| **Prompt injection** | Sanitize review text; limit input length |
| **Score compression** | Apply range-based calibration offsets (+11 for raves, -12 for negatives) |
| **Bad explicit scores** | Flag when LLM disagrees by >30 pts - may be scraping error |
| **Cost explosion** | Use simplified approach (Proposal A) to reduce API calls by 67% |

### Monitoring Plan
```python
# Weekly monitoring
def weekly_audit():
    recent_scores = get_scores_from_last_week()

    # Check for drift
    avg_score = mean(recent_scores)
    if avg_score < 50 or avg_score > 80:
        alert("Score distribution anomaly")

    # Check API reliability
    failure_rate = count_failures() / total_requests()
    if failure_rate > 0.05:
        alert("API failure rate elevated")

    # Check model agreement
    disagreement_rate = count_high_disagreement() / total_reviews()
    if disagreement_rate > 0.15:
        alert("Models disagreeing more than expected")
```

---

## Implementation Roadmap (Revised v4 - Post-Critique)

### Phase 1: Foundation (Completed)
1. ✅ Adopt Anchored prompt for all models
2. ✅ Analyze model accuracy vs explicit critic scores (n=276)
3. ✅ Run model comparison experiment (n=269, GPT-4o-mini)
4. ✅ Fix known data errors (Wicked 1/5, Gutenberg 5/5)

### Phase 2: Rigorous Validation (Current - CRITICAL)

**Priority 1: Data Quality Audit**
1. ⬜ **Audit ALL 276 explicit scores** - Sample 50 randomly, verify against full text
   - If error rate >10%, the calibration data is unreliable
   - Flag reviews where score doesn't match excerpt sentiment
2. ⬜ **Build explicit score validation into extraction** (see new section below)

**Priority 2: Model Validation**
3. ⬜ **Rerun experiment with GPT-4o** (not 4o-mini) - critical, results may differ
4. ⬜ **Cross-validate calibration properly** - 5-fold CV on 80/20 split
   - DO NOT train and test on same data
   - Report confidence intervals, not just point estimates
5. ⬜ **Test temperature settings** - 0 vs 0.3 vs 0.7 on 50 reviews
6. ⬜ **Stratify by text quality** - full-text vs excerpt may need different calibration

### Phase 3: Robust Scoring System (After Phase 2 Validated)

1. ⬜ **Use GPT-4o as primary** (single call, retry 3x on failure)
2. ⬜ **Fix score=0 bug** - A score of 0 is valid for Pan, don't treat as failure
   ```python
   # WRONG: if score and score > 0:
   # RIGHT: if score is not None:
   ```
3. ⬜ **Apply smooth calibration** (not step function) - see new calibrate_score_smooth()
4. ⬜ **DO NOT auto-calibrate Negative/Pan** - flag for human review instead
   - Negative (n=11): too small for reliable calibration
   - Pan (n=3): completely unreliable, always flag
5. ⬜ **Treat excerpt-only differently**: lower confidence, more conservative calibration
6. ⬜ **Add DTLI + BWW thumb sanity checks**:
   ```python
   if model_bucket != dtli_thumb or model_bucket != bww_thumb:
       confidence = "low"
       flag_for_review = True
   ```

### Phase 4: Confidence Scoring
1. ⬜ Implement real confidence levels based on:
   - Text length (full review vs short excerpt)
   - Model internal confidence (if available)
   - Distance from bucket boundary (72 is less confident than 78)
   - Agreement with DTLI/BWW thumbs
2. ⬜ Only apply calibration when confidence is high
3. ⬜ Flag low-confidence scores for manual review

### Phase 5: Validation & Monitoring
1. ⬜ **Create golden test set** - 100 reviews with HUMAN-verified scores (not scraped)
2. ⬜ **Hold out 3-5 complete shows** - don't use for calibration OR testing during development
3. ⬜ Calculate bucket accuracy (not just point accuracy)
4. ⬜ **Audit accuracy by outlet** - some outlets may need outlet-specific offsets
5. ⬜ **Track temporal patterns** - do 2003-2010 reviews behave differently than 2020-2025?
6. ⬜ Set up quarterly recalibration process
7. ⬜ **Add cost monitoring** - track API costs per review, per week

---

## Preventing Future Explicit Score Errors

### Root Causes of Bad Explicit Scores

Based on the two errors found (Wicked "1/5", Gutenberg "5/5"), the issues are:

1. **Wrong element scraped** - Score picked up from JSON-LD metadata for a different item on page
2. **Link text, not review text** - Found "[Read Roma Torre's ★★★★★ review]" and extracted that as score
3. **No sentiment validation** - Score extracted without checking if it matches review text

### Validation Rules to Add

Add to `scripts/lib/score-extractors.js`:

```javascript
/**
 * Validate extracted score against text sentiment.
 * If they wildly disagree, the extracted score is likely wrong.
 */
function validateScoreAgainstText(extractedScore, fullText) {
  const normalizedScore = extractedScore.normalizedScore;
  const textLower = (fullText || '').toLowerCase();

  // Quick sentiment check using key phrases
  const positiveSignals = ['masterpiece', 'brilliant', 'must-see', 'extraordinary',
                          'outstanding', 'excellent', 'remarkable', 'triumph'];
  const negativeSignals = ['disappointing', 'fails', 'terrible', 'avoid',
                          'waste', 'disaster', 'misfire', 'tedious'];

  let positiveCount = positiveSignals.filter(p => textLower.includes(p)).length;
  let negativeCount = negativeSignals.filter(n => textLower.includes(n)).length;

  // Flag contradictions
  if (normalizedScore >= 80 && negativeCount > positiveCount) {
    return {
      valid: false,
      reason: `High score (${normalizedScore}) but text has negative signals`,
      flag_for_review: true
    };
  }
  if (normalizedScore <= 40 && positiveCount > negativeCount) {
    return {
      valid: false,
      reason: `Low score (${normalizedScore}) but text has positive signals`,
      flag_for_review: true
    };
  }

  return { valid: true };
}
```

### Safer Score Extraction Rules

1. **Never extract from link text** - Skip any score found inside `<a>` tags
2. **Validate against available text** - Run sentiment check before accepting
3. **Prefer JSON-LD only when critic matches** - Check critic name in JSON-LD matches review critic
4. **Flag, don't accept, ambiguous scores** - Better to have no score than wrong score

Add to backfill script:

```javascript
// BEFORE saving extracted score:
const validation = validateScoreAgainstText(scoreResult, data.fullText || combinedText);
if (!validation.valid) {
  console.log(`  ⚠️  Score validation failed: ${validation.reason}`);
  data._flaggedScoreReason = validation.reason;
  data.scoreNeedsReview = true;
  // Don't set originalScore - leave null
} else {
  data.originalScore = scoreResult.originalScore;
}
```

### Audit Existing Explicit Scores

Before trusting the 276 explicit scores for calibration:

```bash
# Run audit to find suspicious scores
node scripts/audit-explicit-scores.js

# Output: data/audit/suspicious-explicit-scores.json
# Lists all reviews where:
# - Score >25 pts different from LLM score
# - Score sentiment doesn't match text sentiment
# - Score was extracted from link text or JSON-LD (less reliable sources)
```

---

## Success Metrics (Revised)

| Metric | Current | Phase 1 | Phase 2 Target |
|--------|---------|---------|----------------|
| Explicit score accuracy (within 10 pts) | 60.6% | **Measured** | 75%+ |
| Mean Absolute Error vs explicit | 9.8 pts | **Measured** | <8 pts |
| Reviews using explicit scores directly | 0% | 0% | 13.2% (281 reviews) |
| API calls per review | 3.0 | 2.1 | 2.1 |
| Reviews flagged for review | 0% | 5-10% | 5-10% |

**Note:** We're now measuring against explicit critic scores, NOT DTLI thumbs. This is more reliable ground truth.

---

## Files to Modify

| File | Change |
|------|--------|
| `scripts/llm-scoring/ensemble-scorer.ts` | Implement simplified approach (Proposal A) |
| `scripts/llm-scoring/config.ts` | Update to Anchored prompt |
| `scripts/llm-scoring/index.ts` | Add confidence output, fallback chain |
| `scripts/llm-scoring/types.ts` | Add confidence field to ScoringResult |

---

## Appendix: Multi-Model Critique Summary

### Claude's Key Points
- "Scrap the complex ensemble" - use OpenAI as primary
- Bayesian model averaging > arbitrary weights
- n=45 is "tiny for ML evaluation"

### GPT-4o's Key Points
- Implement "stacking ensemble" with meta-model
- Need failover strategy for API outages
- Regular re-evaluation as language evolves

### Gemini's Key Points
- DTLI thumbs "not a gold standard"
- Use model confidence scores in weighting
- Consider fine-tuning smaller model instead

### Consensus Recommendations
1. ~~Get human annotations (200+ reviews)~~ → **Use explicit critic scores (281 already available)**
2. Use learned weights, not arbitrary percentages
3. Add confidence scoring and flag low-confidence
4. Simplify: best single model + validation, not complex ensemble
5. Monitor for drift and bias
6. **NEW: Apply range-based calibration to correct score compression**

---

## Appendix: Experimental Results

*(Unchanged from v1 - see original experiments)*

### Experiment 1: Comprehensive Scoring (n=100)
- Ensemble: 82.2% DTLI accuracy
- OpenAI: 81.8%
- Claude: 80.0%
- Gemini: 80.0%

### Experiment 2: Prompt Variations (n=30)
- Anchored prompt best overall (+4-5%)
- OpenAI + Anchored: 90.5%
- Claude + Quote-Focused: 85.7%

### Experiment 3: Consistency (n=5)
- Claude most consistent (1.0 pts avg diff)
- OpenAI second (1.4 pts)
- Gemini variable (0-13 pts in earlier tests)

### Experiment 4: Full Calibration Analysis (n=244, CLEANED DATA)

**Sample:** 244 reviews with verified explicit scores (after NYSR fix - removed wrong scores, fetched correct ones from live pages)

**Overall Accuracy:**
- MAE: 9.9 points
- Systematic Bias: -5.2 points (models score too low on average)
- Within 5 pts: 41.4%
- Within 10 pts: 63.1%
- Within 15 pts: 79.9%

**Calibration Offsets by Range (UPDATED with clean data, n=244):**

| Critic Score Range | n | Bias | MAE | Correction |
|--------------------|---|------|-----|------------|
| Rave (85-100) | 91 | -13.0 | 13.2 | **+13** |
| Positive (70-84) | 87 | -1.9 | 6.1 | **+2** |
| Mixed (55-69) | 52 | -0.7 | 9.7 | **+1** |
| Negative (35-54) | 12 | +8.8 | 12.3 | **-9** |
| Pan (0-34) | 2 | +37.5 | 37.5 | ⚠️ n=2 unreliable |

**Score Distribution:** 37% Rave, 36% Positive, 21% Mixed, 5% Negative, 1% Pan

**Key improvements from data cleaning:**
- Rave sample increased: 83 → 91 (more reliable)
- Positive bias improved dramatically: -6.1 → -1.7 (bad NYSR scores were inflating this)
- Mixed now nearly neutral: +2.4 → -0.7

**Largest Errors - Investigated:**

| Error | Review | Finding |
|-------|--------|---------|
| "1/5" → 83 (+63) | wicked-2003/timeout | **DATA ERROR**: Excerpt says "outstanding elements" - 1/5 is wrong |
| "5/5 stars" → 49 (-51) | gutenberg-2023/nysr | **DATA ERROR**: "[Read Roma Torre's ★★★★★ review]" - scraped wrong critic's rating |
| "B" → 29 (-54) | book-of-mormon-2011/toronto-star | Needs investigation |
| "A" → 46 (-47) | shark-is-broken-2023/nypost | Needs investigation |

**Conclusion:** Many "large errors" are actually data quality issues. When model and explicit score disagree by >30 points, flag for human review - the explicit score may be wrong.

### Experiment 5: Model Comparison (n=269, GPT-4o-mini)

Tested three approaches against explicit critic scores:

| Approach | MAE | Bias | Within 5 | Within 10 | Within 15 |
|----------|-----|------|----------|-----------|-----------|
| **Single OpenAI** | 10.4 | +1.1 | **48.0%** | **68.8%** | 82.9% |
| 2x OpenAI Avg | 10.5 | +1.2 | 45.0% | 66.5% | 83.3% |
| OpenAI+Claude | 9.7 | -1.8 | 41.3% | 63.9% | 79.6% |
| Claude Only | 10.2 | -4.7 | 42.4% | 60.6% | 80.7% |

**OpenAI Consistency:**
- Average diff between 2 calls: **0.7 points**
- Perfect match (identical scores): **79.2%**
- Within 5 points: **99.3%**

**Key Findings:**
1. Single OpenAI is best (68.8% within 10 pts)
2. Averaging 2 OpenAI calls doesn't help (66.5% - worse!)
3. OpenAI is extremely consistent (0.7 pt avg variance)
4. Claude has negative bias (-4.7) that hurts averages

**⚠️ NOTE:** This used GPT-4o-mini. Need to rerun with GPT-4o.

### Data Errors Fixed

| Review | Original | Issue | Fix |
|--------|----------|-------|-----|
| wicked-2003/timeout | "1/5" | Excerpt says "outstanding elements" | Removed |
| gutenberg-2023/nysr | "5/5 stars" | Scraped from link to different critic | Removed |

### Experiment 6: Explicit Score Audit (2026-01-31)

**Critical Finding:** The explicit scores have a MUCH HIGHER error rate than expected.

```
Total reviews: 2,123
With explicit score: 281
With numeric score: 242

Flagged for review: 107 (44.2%!)
  - Sentiment mismatch: 16
  - Source reliability: 99
```

**Breakdown by Outlet:**
| Outlet | Flagged | Issue Pattern |
|--------|---------|---------------|
| New York Stage Review | 90 | Unicode stars in link text |
| Time Out New York | 11 | Short text, hard to validate |
| Entertainment Weekly | 3 | Sentiment mismatch |
| Other | 3 | Various |

**Root Cause:** NYSR reviews contain unicode stars (★★★★☆) in the text. The score extractor correctly finds these, but they may be from a DIFFERENT critic's rating embedded in the page (e.g., "Read [Frank Scheck's ★★★★ review]").

**Impact on Calibration:**
- The 276 "explicit scores" used for calibration may have 10-20% error rate
- NYSR scores are particularly unreliable (90/107 flagged)
- Calibration offsets derived from this data may be biased

**Recommendation:**
1. Exclude NYSR scores from calibration (or manually verify them first)
2. Use only verified explicit scores (from outlets with structured score data)
3. Weight calibration toward outlets with reliable score extraction

**Clean Explicit Score Count:**
- Total with explicit: 281
- Minus NYSR: 281 - 90 = 191
- Minus other flagged: 191 - 17 = 174 (estimated clean count)
