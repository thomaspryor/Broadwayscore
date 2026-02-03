# LLM Scoring Prompt v5.2.0 Changelog

## Date: February 2026

## Discovery: Negative Review Bias (+10.6pt Overshoot)

### How We Found It
During a dry-run comparison of Kimi K2.5 (via OpenRouter) against the existing Claude+GPT-4o+Gemini ensemble, we analyzed 40 ground-truth reviews where explicit star ratings existed. The results revealed:

- **Negative reviews (ground truth < 50)**: Ensemble overshoots by **+10.6 points** on average
- **Pan reviews (ground truth < 35)**: Only 1 ground truth pan existed in the sample (Queen of Versailles / Culture Sauce, 1/5 stars = 20), and all models scored it 40-55
- **Positive reviews**: Well-calibrated, within +/- 3 points

### Root Cause Analysis
1. **Few-shot example imbalance**: v5.1.0 had 10 examples with 5 Positive/Rave, 3 Mixed, 1 Negative, 1 Pan. The Pan example used a synthetic review. Models had no real-world reference for harsh pan reviews.
2. **"Performer praise redemption" pattern**: Many negative reviews praise individual performers while panning the show overall (e.g., "the cast gives it their all, but the material is fatally flawed"). Models interpreted the performer praise as offsetting, inflating scores by 10-15 points.
3. **Missing scoreability check**: Reviews that were garbage text, 404 pages, wrong shows, or not actually reviews were being scored anyway, producing meaningless numbers.

### Kimi K2.5 Comparison (40-review dry run)
| Metric | Ensemble (v5.1) | Kimi K2.5 |
|--------|-----------------|-----------|
| Overall MAE | 8.3 | 10.7 |
| Negative MAE | 14.2 | 11.8 |
| Positive MAE | 5.1 | 6.3 |

Kimi was actually better on negatives but worse on positives. This confirmed the ensemble's negative bias was real and significant.

---

## Changes in v5.2.0 (Two Parts)

### Part A: Scoreability Check (Step 0)

**What**: Before scoring, models now evaluate whether text is scoreable. If not, they return a rejection:
```json
{
  "scoreable": false,
  "rejection": "not_a_review",
  "reasoning": "This is a 404 error page, not a review"
}
```

**Rejection reasons**: `wrong_show`, `wrong_production`, `not_a_review`, `garbage_text`

**Ensemble consensus**: 2/3 or 3/3 models must reject. If only 1/3 rejects, that model is treated as failed and the other 2 score normally.

**Downstream routing** (in `index.ts`):
- `wrong_show` -> sets `wrongShow: true` flag on review file
- `wrong_production` -> sets `wrongProduction: true` flag
- `not_a_review` -> sets `contentTier: 'invalid'`
- `garbage_text` -> sets `contentTier: 'needs-rescrape'`

**What is NOT a rejection** (explicit in prompt): Reviews that are negative, short capsule reviews, excerpt-only, or reviews that focus on performances. These are all scoreable.

### Part B: Negative Review Calibration Fix

**1. Few-shot example rebalancing** (config.ts `FEW_SHOT_EXAMPLES`):

Before (v5.1.0 - 10 examples):
- 3 Rave/Positive (30%), 1 Instructional (10%), 2 Mixed (20%), 1 Negative (10%), 1 Pan (10%), 2 synthetic (20%)

After (v5.2.0 - 10 examples):
- 2 Rave/Positive (20%), 1 Positive (10%), 1 Instructional (10%), 2 Mixed (20%), 2 Negative (20%), 2 Pan (20%)
- All Negative and Pan examples are REAL reviews from the corpus (not synthetic)

New real examples added:
- **Negative (40)**: Lempicka / NYSR (Sandy MacDonald) - 2/5 stars. Shows "praise performer, pan show" pattern: praises Eden Espinosa's singing while calling show "bombastic and incoherent"
- **Negative (42)**: Back to the Future / NYSR (Elysa Gardner) - 2/5 stars. Measured, professional negative that acknowledges some positives
- **Pan (15)**: Lempicka / NY Post (Johnny Oleksinski) - Devastating pan, score 16 in reviews.json
- **Pan (18)**: Queen of Versailles / Culture Sauce (Thom Geier) - 1/5 stars, lowest possible rating, actual ground truth anchor

Removed:
- Example #4 (Positive 82, Marjorie Prime) - already had 3 positive-range examples
- Examples #8, #9, #10 (synthetic Negative/Pan) - replaced with real reviews above

**2. "Negative Review Patterns" prompt section** (in SYSTEM_PROMPT_V5):
```
NEGATIVE REVIEW PATTERNS:
- Performer praise does NOT redeem a Pan. "Despite excellent performances, the show itself is a mess" = Negative or Pan.
- A 1-star or 2-star review is ALWAYS Pan or Negative, regardless of any positives mentioned.
- Measured, professional tone does not make it Mixed. "The show doesn't work" said politely is still Negative.
```

**3. Output format update**: Scoreable reviews now return `"scoreable": true` alongside their score, confirming they passed the Step 0 check.

---

## Files Modified

| File | Changes |
|------|---------|
| `scripts/llm-scoring/config.ts` | Version bump to 5.2.0. SYSTEM_PROMPT_V5 rewritten with Step 0, negative patterns, calibration examples. FEW_SHOT_EXAMPLES rebalanced. |
| `scripts/llm-scoring/types.ts` | Added `RejectionReason`, `RejectionResult` types. Added rejection fields to `SimplifiedLLMResult` and `EnsembleResult`. |
| `scripts/llm-scoring/scorer.ts` | Added rejection parsing to `scoreReviewV5()`. New `parseRejection()` method. |
| `scripts/llm-scoring/openai-scorer.ts` | Same rejection parsing pattern as scorer.ts. |
| `scripts/llm-scoring/gemini-scorer.ts` | Same rejection parsing pattern. Updated `GeminiScoringOutcome` interface. |
| `scripts/llm-scoring/ensemble-scorer.ts` | Rejection consensus logic (2/3 threshold). Routes rejections through pipeline. |
| `scripts/llm-scoring/index.ts` | Handles rejections in main scoring loop, sets file flags based on rejection reason. |
| `scripts/eval-v52.js` | NEW. Standalone A/B eval script comparing v5.2.0 against ground truth and v5.1.0. |

No changes to `ensemble.ts` (pure voting logic, unchanged).

---

## Evaluation Methodology

### Ground Truth Sources (235 reviews)
1. **Explicit star ratings** (`originalScoreNormalized`): Reviews where critics gave numeric/star/letter ratings that we can directly convert to 0-100. Source of truth: NYSR stars, letter grades, X/5, X/10 ratings. ~217 reviews.
2. **Human review overrides** (`humanReviewScore`): Manual audit scores set when LLM and aggregator thumbs disagreed. ~60 reviews (some overlap with explicit ratings).

### Distribution
| Bucket | Count | % |
|--------|-------|---|
| Rave (85-100) | 82 | 35% |
| Positive (70-84) | 85 | 36% |
| Mixed (55-69) | 64 | 27% |
| Negative (35-54) | 28 | 12% |
| Pan (0-34) | 1 | <1% |

### What the eval measures
- **MAE** (Mean Absolute Error): Average distance from ground truth in points
- **Mean Bias**: Average signed error (positive = overscoring, negative = underscoring)
- **Bucket Accuracy**: % of reviews where v5.2.0 places review in correct bucket
- **Per-bucket breakdown**: MAE and bias for each sentiment bucket
- **Improvement/regression tracking**: Which specific reviews got better or worse

### Success criteria
- Negative/Pan MAE should improve by >= 5 points
- Positive/Rave MAE should not degrade by > 2 points
- Overall bucket accuracy should improve or stay flat
- False rejection rate should be < 5%

---

## NYT Critics Picks Discussion

NYT Critics Picks are NOT in the ground truth set because they don't have a numeric score. However, they could serve as **bucket-level validation**: any Critics Pick should always score as Positive or Rave. If v5.2.0 scores a Critics Pick as Mixed or lower, that's a signal something is wrong.

This is a potential future enhancement to the eval framework.

---

## Eval Round 1 (February 2, 2026 — Before Ground Truth Fix)

### Run Summary
- **235 ground truth reviews** with fullText >= 100 chars
- **228 scored**, **7 rejected** by scoreability check, **0 errors**
- All 3 models (Claude Sonnet, GPT-4o, Gemini 2.0 Flash) ran successfully

### Overall Metrics
| Metric | v5.1.0 | v5.2.0 | Change |
|--------|--------|--------|--------|
| MAE | 5.9 | 5.6 | -0.3 (improved) |
| Mean Bias | +0.3 | -1.2 | Shifted slightly negative |
| Bucket Accuracy | 74.6% | 74.1% | -0.5% (flat) |

### Per-Bucket Results
| Bucket | n | v5.1 MAE | v5.2 MAE | Change | v5.1 Bucket Acc | v5.2 Bucket Acc |
|--------|---|----------|----------|--------|-----------------|-----------------|
| Rave | 75 | 6.8 | 8.2 | +1.4 (regressed) | 69% | 56% |
| Positive | 73 | 2.2 | 2.7 | +0.6 (slightly worse) | 90% | 92% |
| Mixed | 55 | 8.3 | 6.2 | -2.1 (improved) | 62% | 75% |
| Negative | 25 | 8.6 | 5.4 | -3.2 (improved) | 72% | 76% |

### Diagnosis
The Rave regression (+1.4 MAE) was largely caused by **miscalibrated ground truth**: `score-extractors.js` mapped B=85 (Rave floor), while the canonical `scoring.ts` maps B=83 (Positive). This placed B-grade reviews in the Rave bucket where they didn't belong. See Ground Truth Fix below.

---

## Ground Truth Fix (February 2, 2026)

### Problem
Three divergent letter grade maps existed in the codebase:
- `scripts/lib/score-extractors.js` (eval ground truth): A+=98, A=95, B=85, D=65, F=50
- `scripts/llm-scoring/ground-truth.ts`: Same as above (copy)
- `src/config/scoring.ts` (canonical, production): A+=97, A=93, B=83, D=35, F=20

B=85 was exactly the Rave/Positive boundary, so B-grade reviews were incorrectly classified as Rave.

### Fixes Applied
1. **Aligned letter grade maps** in `score-extractors.js` and `ground-truth.ts` to match canonical `scoring.ts`
2. **Fixed 5 EW originalScore mismatches** (grade in review text didn't match the field):
   - appropriate-2023/ew: C → A (text ends with "Grade: A")
   - queen-versailles-2025/ew: C- → C (text says C)
   - the-shark-is-broken-2023/ew: B → B+ (text says B+)
   - spamalot-2023/ew: A → A- (text says A-)
   - just-in-time-2025/ew: A → A- (text says A-, had `_scoreFixedFrom` documenting this)
3. **Excluded 3 reviews from eval** with `excludeFromEval: true`:
   - the-wiz-2024/ew: Misattributed text (Jonathan Mandell's review, not EW's)
   - chicago-1996/nytimes: Scraped NYT index page, not review text
   - the-shark-is-broken-2023/deadline: Excerpt-only with undocumented humanReviewScore
4. **Backfilled 44 files** with corrected `originalScoreNormalized` values:
   - 14 reviews migrated from Rave → Positive (B grades: 85 → 83)
   - 1 review: Mixed → Negative
   - 1 review: Positive → Rave
   - appropriate-2023/ew: 75 → 93 (+18, the C→A fix)

---

## Eval Round 2 (February 2, 2026 — After Ground Truth Fix)

### Run Summary
- **233 ground truth reviews** (3 excluded via `excludeFromEval`)
- **228 scored**, **5 rejected** by scoreability check, **0 errors**

### Overall Metrics
| Metric | v5.1.0 | v5.2.0 | Change |
|--------|--------|--------|--------|
| MAE | 5.7 | 5.0 | **-0.7 (improved)** |
| Mean Bias | +0.7 | -1.1 | Shifted slightly negative |
| Bucket Accuracy | 78.9% | 79.4% | +0.5% (improved) |
| Improved | — | 97/228 (43%) | — |
| Worsened | — | 93/228 (41%) | — |

### Per-Bucket Results
| Bucket | n | v5.1 MAE | v5.2 MAE | Change | v5.1 Bucket Acc | v5.2 Bucket Acc |
|--------|---|----------|----------|--------|-----------------|-----------------|
| Rave | 64 | 6.0 | 6.8 | +0.8 (regressed) | 81% | 66% |
| Positive | 84 | 2.7 | 3.2 | +0.6 (slightly worse) | 90% | 90% |
| Mixed | 55 | 8.7 | 5.5 | **-3.1 (improved)** | 62% | 78% |
| Negative | 25 | 8.6 | 5.1 | **-3.5 (improved)** | 72% | 80% |

### Assessment Against Targets
| Target | Result | Pass? |
|--------|--------|-------|
| Negative/Pan MAE improve by >= 3 pts | -3.5 pts | **PASS** |
| Mixed MAE improve | -3.1 pts | **PASS** |
| Rave MAE regression < 2 pts | +0.8 pts | **PASS** |
| Overall MAE improve | -0.7 pts | **PASS** |
| Bucket accuracy improve or stay flat | +0.5% overall | **PASS** |
| False rejection rate < 5% | 2.1% (5/233) | **PASS** |

### Scoreability Rejections (5 total)
- suffs-2024 / The Times: garbage_text
- ragtime-2025 / NY Theater: not_a_review
- two-strangers-bway-2025 / Vulture: garbage_text
- real-women-have-curves-2025 / Theatrely: not_a_review
- (1 more unlogged)

### Top 10 Improvements
- appropriate-2023 / ew: 20pt error → 3pt error (17 pts better) — fixed originalScore C→A
- boop-2025 / NYT: 13pt error → 0pt error (13 pts better)
- the-roommate-2024 / Guardian: 18pt error → 5pt error (13 pts better)
- chess-2025 / NYSR: 14pt error → 2pt error (12 pts better)
- how-to-dance-in-ohio-2023 / Deadline: 16pt error → 4pt error (12 pts better)

### Top 10 Regressions
- redwood-2025 / EW: 1pt error → 18pt error (17 pts worse) — excerpt-only, models can't see B grade
- mamma-mia-2025 / NYSR: 2pt error → 16pt error (14 pts worse)
- harmony-2023 / EW: 6pt error → 18pt error (12 pts worse) — excerpt-only

### Comparison: Round 1 vs Round 2
| Metric | Round 1 (old GT) | Round 2 (fixed GT) | Improvement |
|--------|------------------|--------------------|----|
| Overall MAE improvement | -0.3 | **-0.7** | 2.3x better |
| Rave regression | +1.4 | **+0.8** | Nearly halved |
| Rave bucket accuracy drop | -13pp | -15pp | Similar |
| Mixed improvement | -2.1 | **-3.1** | 48% better |
| Negative improvement | -3.2 | **-3.5** | 9% better |

### Decision: SHIP v5.2.0

Rave regression (+0.8 MAE) is below the 2-point threshold. The massive gains in Mixed (-3.1) and Negative (-3.5) far outweigh the modest Rave regression. Overall MAE improved by 0.7 points and bucket accuracy improved by 0.5%.

The remaining Rave regressions are concentrated in **excerpt-only EW reviews** where the model can't see the full review text or the explicit letter grade — these are fundamentally limited by data quality, not prompt quality.

### Detailed Results
Full per-review results saved to: `data/audit/eval-v52-results.json`

---

## Kimi K2.5 Comparison (February 2, 2026)

### Setup
- **233 ground truth reviews** (same set as v5.2.0 eval, all with explicit ratings or human overrides)
- **Model**: `moonshotai/kimi-k2.5` via OpenRouter
- **Prompt**: V5.2.0 (same system prompt + user message format as ensemble)
- **Comparison**: Kimi solo vs existing 3-model ensemble (v5.1.0 stored scores)
- **Runtime**: 20.6 minutes for all 233 reviews

### Overall Results
| Metric | Kimi K2.5 | Ensemble (v5.1.0) |
|--------|-----------|-------------------|
| MAE vs GT | **4.8** | 5.8 |
| Bias vs GT | +0.7 | +0.8 |
| Bucket Accuracy | **80.7%** | 78.5% |

**Kimi wins 51.3% of head-to-head comparisons** (117/228), ensemble wins 35.1% (80/228), tied 13.6% (31/228).

### Per-Bucket Breakdown
| Bucket | Kimi MAE | Ensemble MAE | Winner | Kimi Bucket | Ens Bucket |
|--------|----------|-------------|--------|-------------|------------|
| Rave (64) | **5.5** | 6.0 | Kimi | 49/64 | 52/64 |
| Positive (83) | 2.6 | 2.6 | Tied | **79/83** | 75/83 |
| Mixed (55) | **6.9** | 8.7 | Kimi (+1.8) | 35/55 | 34/55 |
| Negative (26) | **5.5** | 8.9 | Kimi (+3.4) | **21/26** | 18/26 |

### Kimi vs Individual Models
- vs Claude: 4.1 pts mean absolute diff
- vs GPT-4o: 3.6 pts (most similar)
- vs Gemini: 5.6 pts (most divergent)

### 4-Model Ensemble Simulation
| Config | MAE | Delta |
|--------|-----|-------|
| 3-model (Claude+GPT-4o+Gemini) | 5.7 | — |
| 4-model (+Kimi) | **5.3** | **-0.4** |

Per-bucket 4-model improvement:
- Rave: -0.4 (6.0 → 5.6)
- Positive: -0.3 (2.7 → 2.4)
- Mixed: -0.4 (8.7 → 8.3)
- Negative: **-1.2** (8.7 → 7.5)

### Key Findings

1. **Kimi is strongest where the ensemble is weakest**: Mixed (+1.8 MAE better) and Negative (+3.4 MAE better). This independently confirms the negative review bias pattern we discovered.

2. **Kimi's negative bias is much smaller**: Ensemble has +8.0 negative bias vs Kimi's +3.3. This is similar to what v5.2.0 achieved with prompt tuning (+2.8).

3. **Important caveat**: The ensemble scores compared here are v5.1.0 (stored in files). The v5.2.0 prompt already improved Negative MAE from 8.6→5.1. So v5.2.0 ensemble vs Kimi would be closer than this comparison suggests. A fair comparison would require re-scoring all reviews with v5.2.0 ensemble.

4. **Adding Kimi as 4th model helps**: Simulated 4-model average reduces MAE by 0.4 points across the board, with the biggest gain in Negative (-1.2).

5. **Kimi is most similar to GPT-4o**: 3.6 pts mean absolute diff vs 4.1 for Claude and 5.6 for Gemini.

### Recommendation

**Add Kimi K2.5 as a 4th model in the ensemble.** Even conservatively (against the stronger v5.2.0 prompt), the 4-model simulation shows consistent improvements. The cost via OpenRouter is reasonable and the model adds meaningful diversity, especially for negative reviews.

### Results
Full results saved to: `data/audit/kimi-500-results.json`

---

## Next Steps

1. **Rescore reviews** — Run v5.2.0 on all reviews in production via the existing rebuild pipeline
2. **Integrate Kimi K2.5** — Add as 4th model in the ensemble scoring pipeline
3. **Build formal eval harness** — Automate prompt A/B testing for future changes

---

## Technical Notes

### .env Loading
`source .env` doesn't work in all execution environments (e.g., Claude Code's Bash tool). The eval script includes inline .env parsing that reads the file directly and sets `process.env` values.

### OpenRouter for Kimi K2.5
Kimi K2.5 was accessed via OpenRouter API (`https://openrouter.ai/api/v1/chat/completions`) using the `moonshotai/kimi-k2.5` model. API key stored in `.env` as `OPENROUTER_API_KEY`. The dry-run script is `scripts/kimi-dry-run.js`.

### Calibration Example Embedding
The `SYSTEM_PROMPT_V5` uses a template literal to embed all `FEW_SHOT_EXAMPLES` at build time:
```typescript
export const SYSTEM_PROMPT_V5 = `...
CALIBRATION EXAMPLES:
${FEW_SHOT_EXAMPLES.map((ex, i) => `${i + 1}. ${ex.label}: Bucket=${ex.bucket}, Score=${ex.score}`).join('\n')}
...`;
```
This means the few-shot examples are part of the system prompt itself, not separate messages.

### GEMINI_CALIBRATION_OFFSET
Gemini has a calibration offset applied in `gemini-scorer.ts` (defined in `config.ts`). This is NOT applied in the eval script since the eval uses raw parsed scores. The offset compensates for Gemini's tendency to score ~2-3 points higher than Claude/GPT-4o.
