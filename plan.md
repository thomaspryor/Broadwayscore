# Plan: Prompt V5.2 — Scoreability Check + Negative Calibration Fix

**Status: COMPLETED AND SHIPPED (February 2, 2026)**

- v5.2.0 deployed to `scripts/llm-scoring/config.ts`
- Kimi K2.5 integrated as 4th ensemble model via OpenRouter
- Two eval rounds completed (see `scripts/llm-scoring/CHANGELOG-v52.md` for full results)
- Results: Overall MAE improved by 0.7pts, Negative MAE improved by 3.5pts, bucket accuracy +0.5%

## Overview

Two problems, one prompt update. Version `5.1.0` → `5.2.0`.

**Problem A:** Models score garbage/wrong-show/truncated text blindly, producing bad scores instead of flagging the input.
**Problem B:** Models systematically overshoot negative reviews by +10.6 points vs human ground truth.

Both are fixed in `SYSTEM_PROMPT_V5` and `FEW_SHOT_EXAMPLES` in `scripts/llm-scoring/config.ts`, plus a small output-handling change in the scoring pipeline.

---

## Part 1: Scoreability Check (New Step 0)

### What Changes in the Prompt

Before the existing "Step 1: Choose the Bucket," add a new Step 0:

```
## Step 0: Is This Text Scoreable?

Before scoring, check if this text is actually a scoreable review of the target show. If ANY of the following apply, DO NOT score — return a rejection instead:

| Rejection Reason | Description |
|-----------------|-------------|
| `wrong_show` | Text is about a completely different show or topic |
| `wrong_production` | Reviews an off-Broadway, touring, or previous production — not the current Broadway run |
| `not_a_review` | Press release, plot summary with no evaluation, cast listing, or promotional content |
| `garbage_text` | Navigation menus, error pages, ad copy, login prompts, or other non-article content |

The following are NOT rejections — score them, but with reduced confidence:

| Situation | How to Handle |
|-----------|--------------|
| **Multi-show roundup** | Score the portion about the target show. Set confidence to "low" if less than ~150 words about it. |
| **Truncated text** | Score what's available. Set confidence to "low" if the verdict/conclusion appears cut off. |
| **Excerpt only** | Score the excerpt. Set confidence to "low". |

If rejecting, respond with ONLY this JSON:
{
  "scoreable": false,
  "rejection": "wrong_show",
  "reasoning": "This text is a recap of Bachelor in Paradise, not a review of Suffs"
}

If scoreable, proceed to Step 1.
```

### What Changes in the Output Format

The normal scoring output adds `"scoreable": true` at the top:

```json
{
  "scoreable": true,
  "bucket": "Positive",
  "score": 79,
  "confidence": "high",
  "verdict": "recommended with reservations",
  "keyQuote": "...",
  "reasoning": "..."
}
```

### What Changes in the Pipeline

In each scorer's `parseResponse()` method (scorer.ts, openai-scorer.ts, gemini-scorer.ts):
- Check for `scoreable: false` in the parsed JSON
- If rejected, return a new outcome type: `{ success: false, rejected: true, rejection: string, reasoning: string }`

In `ensemble-scorer.ts`:
- If all models reject → mark review with rejection reason, skip scoring
- If some reject but others score → use the scoring models only (treat rejectors as "failed")
- This means a garbage review needs 2/3 or 3/3 models to agree it's unscorable before it's rejected — conservative by design

In `index.ts` (CLI pipeline):
- Rejected reviews get written back with `contentTier` updated to match the rejection:
  - `wrong_show` → set `wrongShow: true`
  - `wrong_production` → set `wrongProduction: true`
  - `not_a_review` → set `contentTier: "invalid"`
  - `garbage_text` → set `contentTier: "needs-rescrape"`
- Rejected reviews are logged separately in the run summary

### Multi-Show Roundups (Specifically)

These are NOT rejected. The prompt explicitly says to score the portion about the target show with reduced confidence. This means:
- The model extracts what it can from the relevant paragraph(s)
- It sets `confidence: "low"`
- Downstream, this routes through the existing Priority 2/3 scoring hierarchy — the low-confidence LLM score gets cross-checked against aggregator thumbs (DTLI, BWW) and excerpts
- The aggregator excerpts often contain the most relevant quote from the roundup, providing additional signal
- Net effect: roundups are scored cautiously, with thumbs as a safety net — same as excerpts today

---

## Part 2: Negative Review Calibration Fix

### Root Cause (5 Issues)

1. **Positive-skewed examples** — 50% Positive/Rave, only 10% Pan
2. **No 1-star anchor** — lowest calibration point is score 30
3. **Bad 2-star example** — implies all 2-star reviews have silver linings
4. **Missing "praise performers, pan show" pattern** — the #1 failure mode
5. **Legacy V3 anchors** — conflicting range definitions in same file

### Change A: New "Negative Review Patterns" instruction block

Add after "Critical Instructions" in SYSTEM_PROMPT_V5:

```
## Negative Review Patterns

**PERFORMER PRAISE DOES NOT REDEEM A PAN.** A critic saying "despite a game cast giving their all" or "the lead delivers a committed performance" while panning the book, direction, and overall experience is writing a NEGATIVE review. Score the overall verdict, not the best individual element.

**USE THE FULL PAN RANGE (0-34).** Reviews that question why a show exists, warn audiences away, or find no redeeming qualities should score 10-20. Reserve 25-34 for pans that acknowledge isolated bright spots.
```

### Change B: Rebalanced few-shot examples

| # | Current | Proposed | Source |
|---|---------|----------|--------|
| 1 | Rave (95) synthetic | **KEEP** | Existing |
| 2 | 5-star Positive (87) | **KEEP** | Existing |
| 3 | 4-star Positive (78) | **KEEP** | Existing |
| 4 | Positive (82) | **REMOVE** — already 3 positives | — |
| 5 | Neg-setup-positive-verdict (78) | **KEEP** as instructional | Existing |
| 6 | Mixed-positive (68) | **KEEP** | Existing |
| 7 | Mixed (55) | **KEEP** | Existing |
| 8 | 2-star Negative (45) | **REPLACE** with real 2/5 "praise performer, pan show" (40) | Lempicka / NYSR (Sandy MacDonald) |
| 9 | Negative (42) synthetic | **REPLACE** with real measured negative (42) | Back to the Future / NYSR (Elysa Gardner) |
| 10 | Pan (30) synthetic | **REPLACE** with real devastating pan (15) | Lempicka / NY Post (Johnny Oleksinski) |
| NEW | — | **ADD** 1/5-star Pan anchor (18) | Queen of Versailles / Culture Sauce (Thom Geier) |

**Distribution:** 3 Positive/Rave (27%), 1 Instructional (9%), 2 Mixed (18%), 2 Negative (18%), 2 Pan (18%) + 1 Scoreability rejection example

### Change C: Add a scoreability rejection example

Add one few-shot example showing a rejection:

```
### Example: Not Scoreable
Text: "The page you are looking for no longer exists. Perhaps you can return back to the homepage..."
Response: { "scoreable": false, "rejection": "garbage_text", "reasoning": "This is a 404 error page, not a review." }
```

### Change D: Deprecate V3 anchors

Add `@deprecated` JSDoc to `SCORE_ANCHORS`. No functional change.

---

## Files Modified

| File | Changes |
|------|---------|
| `scripts/llm-scoring/config.ts` | Step 0 in SYSTEM_PROMPT_V5, negative patterns instruction, rebalanced few-shot examples, rejection example, V3 deprecation. Bump PROMPT_VERSION to `5.2.0` |
| `scripts/llm-scoring/scorer.ts` | Handle `scoreable: false` in parseResponse |
| `scripts/llm-scoring/openai-scorer.ts` | Handle `scoreable: false` in parseResponse |
| `scripts/llm-scoring/gemini-scorer.ts` | Handle `scoreable: false` in parseResponse |
| `scripts/llm-scoring/ensemble-scorer.ts` | Consensus logic for rejections (2/3 or 3/3 must reject) |
| `scripts/llm-scoring/ensemble.ts` | New rejection outcome type |
| `scripts/llm-scoring/types.ts` | Add `RejectionResult` type, `scoreable` field |
| `scripts/llm-scoring/index.ts` | Route rejections to contentTier/wrongShow flags, log separately |

---

## Testing Methodology

### Step 1: Assemble ground truth test set (~40 reviews)

- 5 with explicit 1-2 star ratings (Pan/Negative range)
- 5 with explicit 4-5 star ratings (Positive/Rave control)
- 10 with `humanReviewScore` overrides
- 10 with unanimous ensemble agreement + thumb alignment
- 5 known garbage/wrong-show texts (to test scoreability check)
- 5 multi-show roundups (to verify they're scored, not rejected)

### Step 2: Baseline — score with current prompt (v5.1.0)

### Step 3: Score with new prompt (v5.2.0)

### Step 4: Compare

| Metric | v5.1.0 | v5.2.0 | Target |
|--------|--------|--------|--------|
| Negative/Pan MAE vs ground truth | ~10.6 | ? | ≤5.6 (improve by ≥5) |
| Positive/Rave MAE vs ground truth | ? | ? | No degradation >2 pts |
| Bucket accuracy rate | ~70% | ? | ≥75% |
| Garbage correctly rejected | 0/5 | ? | ≥4/5 |
| Multi-show roundups NOT rejected | ? | ? | 5/5 |

### Step 5: If successful, rescore affected reviews

Run v5.2.0 on all Negative/Pan reviews (~280) + all reviews with contentTier "invalid"/"needs-rescrape" (~80). Compare old vs new. Spot-check outliers.

---

## What Does NOT Change

- Ensemble voting logic (3→2→1 fallback)
- Scoring hierarchy (explicit ratings > humanReviewScore > LLM)
- `rebuild-all-reviews.js` pipeline
- No calibration offsets — the prompt teaches models correctly instead
- Multi-show roundups and excerpts still get scored (with low confidence)
- Aggregator thumbs (DTLI/BWW) still serve as cross-check for low-confidence scores

---

## After This: Revisiting Kimi

Once v5.2.0 is deployed and negative scoring is accurate, rerun the Kimi comparison on 500 reviews. The recalibrated prompt will show whether Kimi's "generosity" on negatives was closer to truth (because the ensemble was wrong) or a real model bias. Then decide whether to add it as a 4th model.
