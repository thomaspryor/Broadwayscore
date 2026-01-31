# Sprint Plan: LLM Scoring Phase 3 Implementation

**Version:** 5.0
**Created:** 2026-01-31
**Goal:** Implement three-model ensemble scoring with simplified output, richer context, and calibrated Gemini integration.

---

## Overview

This plan implements the LLM Scoring Phase 3 improvements as specified in `/docs/LLM-SCORING-PHASE-3-REVISED.md`. The key changes are:

1. **Simplified prompt output** - Remove unused fields (range, components, keyPhrases array, flags), add bucket-first scoring
2. **Richer input context** - Add aggregator excerpts/thumbs for truncated texts only, with explicit caveat
3. **Three-model ensemble** - Add Gemini 1.5 Pro alongside Claude Sonnet and GPT-4o
4. **New system prompt** - Bucket-first approach with score-within-range
5. **Calibration pipeline** - 200-review calibration set with Gemini offset tuning
6. **Batched rescore** - Validation gates between batches

---

## Sprint Summary

| Sprint | Goal | Tasks | Duration |
|--------|------|-------|----------|
| **1** | Foundation: Types, config, Gemini adapter | 1.1-1.6 | 2 days |
| **2** | Input context builder & ensemble logic | 2.1-2.5 | 1.5 days |
| **3** | Pre-flight testing & calibration setup | 3.1-3.5 | 1.5 days |
| **4** | Calibration run & Gemini tuning | 4.1-4.4 | 1.5 days |
| **5** | Batched rescore with validation gates | 5.1-5.5 | 2 days |
| **6** | Cleanup, hardening & deployment | 6.1-6.5 | 1.5 days |

**Total:** ~10 days

---

## Sprint 1: Foundation

**Sprint Goal:** Update types, config, and create Gemini scorer adapter with working API integration.

**Risk Flags:**
- GEMINI_API_KEY may not be set up in GitHub secrets yet
- Gemini response format may differ from docs

### Task 1.1: Update TypeScript Types

**ID:** 1.1
**Complexity:** S (< 30 min)
**Depends on:** None
**Parallel:** Yes (with 1.2, 1.3)

**Description:** Update `types.ts` with simplified output types and new ensemble types from Phase 3 spec.

**Files touched:**
- `/Users/tompryor/Broadwayscore/scripts/llm-scoring/types.ts`

**Changes:**
- Add `SimplifiedLLMResult` interface (bucket, score, confidence, verdict, keyQuote, reasoning)
- Add `EnsembleResult` interface with modelResults for 3 models
- Add `ModelScore` interface for individual model outputs
- Update `ScoredReviewFile.llmMetadata` to include `promptVersion: '5.0.0'`, `previousScore`, `previousVersion`

**VERIFY:** `npx tsc --noEmit --project scripts/tsconfig.json` passes without errors

---

### Task 1.2: Update Scoring Config

**ID:** 1.2
**Complexity:** S (< 30 min)
**Depends on:** None
**Parallel:** Yes (with 1.1, 1.3)

**Description:** Update `config.ts` with new bucket ranges, simplified prompt, and bump `PROMPT_VERSION` to 5.0.0.

**Files touched:**
- `/Users/tompryor/Broadwayscore/scripts/llm-scoring/config.ts`

**Changes:**
- Update `SCORE_ANCHORS` to match new bucket ranges: Rave (85-100), Positive (70-84), Mixed (55-69), Negative (35-54), Pan (0-34)
- Update `SYSTEM_PROMPT` with bucket-first approach from Phase 3 spec section 3.4
- Update `SCORING_PROMPT_TEMPLATE` for simplified JSON output
- Bump `PROMPT_VERSION` to `'5.0.0'`
- Add `bucketToRange()` helper function

**VERIFY:** Config exports compile and `PROMPT_VERSION === '5.0.0'`

---

### Task 1.3: Create Gemini Scorer Module

**ID:** 1.3
**Complexity:** M (30-90 min)
**Depends on:** None
**Parallel:** Yes (with 1.1, 1.2)

**Description:** Create new Gemini scorer adapter with response normalization and error handling.

**Files touched:**
- `/Users/tompryor/Broadwayscore/scripts/llm-scoring/gemini-scorer.ts` (NEW)

**Changes:**
- Install `@google/generative-ai` package
- Implement `GeminiScorer` class matching interface from Phase 3 spec section 3.5
- Add `parseResponse()` with markdown code fence stripping
- Add `validateAndNormalize()` to ensure bucket/score consistency
- Add `extractFromMalformed()` fallback for edge cases
- Add retry logic with exponential backoff

**VERIFY:** `npx tsc --noEmit --project scripts/tsconfig.json` passes; module exports `GeminiScorer` class

---

### Task 1.4: Add Gemini Package Dependency

**ID:** 1.4
**Complexity:** S (< 30 min)
**Depends on:** None
**Parallel:** Yes (with 1.1-1.3)

**Description:** Add Google Generative AI SDK to project dependencies.

**Files touched:**
- `/Users/tompryor/Broadwayscore/package.json`

**Changes:**
- Add `@google/generative-ai` to dependencies

**VERIFY:** `npm install` succeeds; `require('@google/generative-ai')` works

---

### Task 1.5: Add GEMINI_API_KEY to Workflow

**ID:** 1.5
**Complexity:** S (< 30 min)
**Depends on:** None
**Parallel:** Yes (with 1.1-1.4)

**Description:** Update GitHub Actions workflow to pass Gemini API key.

**Files touched:**
- `/Users/tompryor/Broadwayscore/.github/workflows/llm-ensemble-score.yml`

**Changes:**
- Add `GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}` to env block
- Add note to workflow about required secret

**VERIFY:** Workflow YAML is valid (`gh workflow view llm-ensemble-score.yml` doesn't error)

---

### Task 1.6: Gemini Scorer Smoke Test Script

**ID:** 1.6
**Complexity:** S (< 30 min)
**Depends on:** 1.3, 1.4
**Parallel:** No

**Description:** Create minimal test script to verify Gemini API connectivity.

**Files touched:**
- `/Users/tompryor/Broadwayscore/scripts/llm-scoring/test-gemini.ts` (NEW)

**Changes:**
- Create script that calls Gemini with a hardcoded test review
- Print raw response and parsed result
- Exit with error code if API fails

**VERIFY:** `GEMINI_API_KEY=... npx ts-node scripts/llm-scoring/test-gemini.ts` returns valid JSON score

---

**Sprint 1 Demo:** Run `test-gemini.ts` and show Gemini returning a valid bucket/score response.

---

## Sprint 2: Input Context & Ensemble Logic

**Sprint Goal:** Build input context builder and update ensemble logic to support 3 models with graceful degradation.

**Risk Flags:**
- Ensemble voting logic has multiple edge cases to handle
- Need to preserve backward compatibility with 2-model fallback

### Task 2.1: Create Input Context Builder

**ID:** 2.1
**Complexity:** M (30-90 min)
**Depends on:** 1.1, 1.2
**Parallel:** Yes (with 2.2)

**Description:** Create module that builds rich context for prompts, adding aggregator data only for truncated texts.

**Files touched:**
- `/Users/tompryor/Broadwayscore/scripts/llm-scoring/input-builder.ts` (NEW)

**Changes:**
- Create `buildScoringInput()` function
- Add metadata context (outlet, tier, show, critic)
- Add text quality warning for truncated texts (using `text-quality.js` module)
- Add aggregator context (thumbs, excerpts) ONLY for truncated texts with explicit caveat
- Include explicit "NOTE: Use this context to help identify the likely verdict, but make your own independent assessment"

**VERIFY:** Function compiles and returns formatted string with conditional aggregator context

---

### Task 2.2: Create Ensemble Module

**ID:** 2.2
**Complexity:** M (30-90 min)
**Depends on:** 1.1, 1.3
**Parallel:** Yes (with 2.1)

**Description:** Create standalone ensemble module with 3-model voting logic from Phase 3 spec section 3.3.

**Files touched:**
- `/Users/tompryor/Broadwayscore/scripts/llm-scoring/ensemble.ts` (NEW)

**Changes:**
- Implement `ensembleScore()` function with full logic from spec
- Implement `threeModelEnsemble()` with unanimous/majority/no-consensus cases
- Implement `twoModelEnsemble()` fallback
- Add graceful degradation (3→2→1→0 models)
- Add median/mean helpers
- Add `scoreToBucket()` helper for no-consensus case

**VERIFY:** Unit tests for ensemble logic pass (add tests in next task)

---

### Task 2.3: Add Ensemble Unit Tests

**ID:** 2.3
**Complexity:** M (30-90 min)
**Depends on:** 2.2
**Parallel:** No

**Description:** Add unit tests for ensemble voting logic edge cases.

**Files touched:**
- `/Users/tompryor/Broadwayscore/tests/unit/ensemble.test.ts` (NEW)

**Changes:**
- Test unanimous agreement (tight spread, wide spread)
- Test 2/3 majority with outlier
- Test 3-way disagreement
- Test 2-model fallback
- Test 1-model fallback
- Test all-fail case

**VERIFY:** `npm test tests/unit/ensemble.test.ts` passes all cases

---

### Task 2.4: Update Ensemble Scorer to Use New Modules

**ID:** 2.4
**Complexity:** M (30-90 min)
**Depends on:** 2.1, 2.2, 1.3
**Parallel:** No

**Description:** Refactor `ensemble-scorer.ts` to use new input builder and 3-model ensemble logic.

**Files touched:**
- `/Users/tompryor/Broadwayscore/scripts/llm-scoring/ensemble-scorer.ts`

**Changes:**
- Import `GeminiScorer` from new module
- Import `buildScoringInput()` from input-builder
- Import `ensembleScore()` from ensemble module
- Add Gemini to parallel scoring calls
- Update `scoreReviewFile()` to use new input builder
- Update result storage to include all 3 model results
- Preserve backward compatibility (if no Gemini key, fall back to 2-model)

**VERIFY:** `npx tsc --noEmit --project scripts/tsconfig.json` passes

---

### Task 2.5: Update Main Index to Support 3-Model Mode

**ID:** 2.5
**Complexity:** S (< 30 min)
**Depends on:** 2.4
**Parallel:** No

**Description:** Update main scoring index to accept Gemini API key and enable 3-model mode.

**Files touched:**
- `/Users/tompryor/Broadwayscore/scripts/llm-scoring/index.ts`

**Changes:**
- Check for `GEMINI_API_KEY` environment variable
- Pass to `EnsembleReviewScorer` constructor
- Log whether running in 2-model or 3-model mode
- Update token usage display for 3 models

**VERIFY:** Running with all 3 API keys logs "Using 3-MODEL mode"

---

**Sprint 2 Demo:** Run ensemble scorer with 3 API keys on 1 review, show all 3 model scores and final ensemble result.

---

## Sprint 3: Pre-flight Testing & Calibration Setup

**Sprint Goal:** Test Gemini integration with diverse reviews and build the 200-review calibration dataset.

**Risk Flags:**
- Gemini may have systematic bias not seen in small tests
- Calibration dataset needs proper stratification

### Task 3.1: Create Pre-flight Test Script

**ID:** 3.1
**Complexity:** M (30-90 min)
**Depends on:** 2.4
**Parallel:** Yes (with 3.2)

**Description:** Create script to test Gemini with 10 diverse reviews (2 per bucket).

**Files touched:**
- `/Users/tompryor/Broadwayscore/scripts/llm-scoring/preflight-test.ts` (NEW)

**Changes:**
- Hardcode 10 test reviews (2 Rave, 2 Positive, 2 Mixed, 2 Negative, 2 Pan)
- Run Gemini scorer on each
- Compare bucket to expected
- Print summary: matches, mismatches, systematic issues
- Exit with error if >2 mismatches

**VERIFY:** Script runs successfully with <3 bucket mismatches

---

### Task 3.2: Build Calibration Dataset Selector

**ID:** 3.2
**Complexity:** M (30-90 min)
**Depends on:** None
**Parallel:** Yes (with 3.1)

**Description:** Create script to select 200 reviews for calibration set following stratification from spec section 3.7.

**Files touched:**
- `/Users/tompryor/Broadwayscore/scripts/build-calibration-set.ts` (NEW)

**Changes:**
- Read all reviews from `data/review-texts/`
- Filter to reviews with both fullText AND aggregator thumbs
- Stratify: 40 per bucket (Rave, Positive, Mixed, Negative, Pan)
- Within each bucket: 50% Tier 1, 30% Tier 2, 20% Tier 3 outlets
- Output to `data/calibration/calibration-set-200.json`

**VERIFY:** Output file has 200 reviews with correct stratification

---

### Task 3.3: Run Calibration Dataset Selection

**ID:** 3.3
**Complexity:** S (< 30 min)
**Depends on:** 3.2
**Parallel:** No

**Description:** Execute calibration set builder and verify output.

**Files touched:**
- `/Users/tompryor/Broadwayscore/data/calibration/calibration-set-200.json` (NEW/UPDATE)

**Changes:**
- Run `build-calibration-set.ts`
- Manually verify bucket distribution in output
- Commit calibration set to repository

**VERIFY:** `calibration-set-200.json` exists with 200 reviews, ~40 per bucket

---

### Task 3.4: Run Pre-flight Gemini Test

**ID:** 3.4
**Complexity:** S (< 30 min)
**Depends on:** 3.1
**Parallel:** No

**Description:** Execute pre-flight test and verify Gemini works correctly.

**Files touched:**
- None (execution only)

**Changes:**
- Run `preflight-test.ts` with Gemini API key
- Document any bucket mismatches
- If >2 mismatches, investigate before proceeding

**VERIFY:** Pre-flight test passes with <3 bucket mismatches

---

### Task 3.5: Create Calibration Runner Script

**ID:** 3.5
**Complexity:** M (30-90 min)
**Depends on:** 3.3, 2.4
**Parallel:** No

**Description:** Create script to run ensemble scoring on calibration set and compute metrics.

**Files touched:**
- `/Users/tompryor/Broadwayscore/scripts/calibrate-ensemble.ts` (NEW)

**Changes:**
- Load calibration set from `calibration-set-200.json`
- Run 3-model ensemble on each review
- Compute metrics from spec section 3.7:
  - 3-model bucket agreement rate
  - 2-model bucket agreement rate
  - Bucket accuracy vs expected
  - Average score spread
  - Severe outlier rate
- Compute Gemini-specific metrics:
  - Gemini systematic bias (mean delta vs other models)
  - Gemini outlier rate
- Output results to `data/calibration/calibration-results.json`

**VERIFY:** Script compiles and outputs metrics JSON

---

**Sprint 3 Demo:** Show pre-flight test passing and calibration set with proper stratification.

---

## Sprint 4: Calibration Run & Gemini Tuning

**Sprint Goal:** Run full calibration, analyze results, and apply Gemini offset if needed.

**Risk Flags:**
- Calibration may reveal Gemini needs significant offset
- May need to iterate on prompt if metrics are poor

### Task 4.1: Run Full Calibration

**ID:** 4.1
**Complexity:** M (30-90 min)
**Depends on:** 3.5, 3.4
**Parallel:** No

**Description:** Execute calibration runner on 200 reviews and analyze results.

**Files touched:**
- `/Users/tompryor/Broadwayscore/data/calibration/calibration-results.json` (NEW)

**Changes:**
- Run `calibrate-ensemble.ts` with all 3 API keys
- Store results
- Expected runtime: ~20 minutes (200 reviews x 3 models)

**VERIFY:** Results show 3-model agreement >= 55% and 2-model agreement >= 88%

---

### Task 4.2: Analyze Gemini Bias

**ID:** 4.2
**Complexity:** S (< 30 min)
**Depends on:** 4.1
**Parallel:** No

**Description:** Analyze calibration results for Gemini systematic bias.

**Files touched:**
- None (analysis only)

**Changes:**
- Review `calibration-results.json`
- Calculate mean Gemini bias vs Claude and OpenAI
- Identify if Gemini consistently scores higher/lower
- Document findings

**VERIFY:** Gemini bias documented; if |bias| > 5 points, proceed to 4.3

---

### Task 4.3: Implement Gemini Calibration Offset (Conditional)

**ID:** 4.3
**Complexity:** S (< 30 min)
**Depends on:** 4.2
**Parallel:** No

**Description:** If Gemini has systematic bias > 5 points, add calibration offset to scorer.

**Files touched:**
- `/Users/tompryor/Broadwayscore/scripts/llm-scoring/gemini-scorer.ts`
- `/Users/tompryor/Broadwayscore/scripts/llm-scoring/config.ts`

**Changes:**
- Add `GEMINI_CALIBRATION_OFFSET` constant to config (e.g., -3 if Gemini scores 3pts high)
- Apply offset in `GeminiScorer.scoreReview()` after parsing
- Log when offset is applied

**VERIFY:** If offset applied, re-run calibration sample shows reduced bias

---

### Task 4.4: Document Calibration Results

**ID:** 4.4
**Complexity:** S (< 30 min)
**Depends on:** 4.1, 4.2, 4.3
**Parallel:** No

**Description:** Document calibration findings and any tuning applied.

**Files touched:**
- `/Users/tompryor/Broadwayscore/data/calibration/CALIBRATION-REPORT.md` (NEW)

**Changes:**
- Document final metrics
- Document Gemini offset if applied
- Note any bucket-specific issues
- Recommend proceed/iterate

**VERIFY:** Report exists with clear pass/fail decision

---

**Sprint 4 Demo:** Show calibration metrics meeting targets (3-model >= 60%, 2-model >= 90%).

---

## Sprint 5: Batched Rescore with Validation Gates

**Sprint Goal:** Rescore all reviews in validated batches with automatic stop on degradation.

**Risk Flags:**
- May hit rate limits with 2000+ reviews x 3 models
- Need robust error handling and resume capability

### Task 5.1: Create Batch Rescore Script

**ID:** 5.1
**Complexity:** L (90+ min) - break into 5.1a, 5.1b
**Depends on:** 4.4
**Parallel:** No

---

#### Task 5.1a: Batch Rescore Core Logic

**ID:** 5.1a
**Complexity:** M (30-90 min)
**Depends on:** 4.4
**Parallel:** Yes (with 5.1b)

**Description:** Create core batch processing logic with checkpointing.

**Files touched:**
- `/Users/tompryor/Broadwayscore/scripts/batch-rescore.ts` (NEW)

**Changes:**
- Accept batch size parameter (default 200)
- Load all reviews needing rescore
- Process in batches with progress tracking
- Save checkpoint after each batch (resume capability)
- Track per-batch metrics

**VERIFY:** Script processes first batch and saves checkpoint

---

#### Task 5.1b: Batch Validation Gates

**ID:** 5.1b
**Complexity:** M (30-90 min)
**Depends on:** 4.4
**Parallel:** Yes (with 5.1a)

**Description:** Add validation gates between batches.

**Files touched:**
- `/Users/tompryor/Broadwayscore/scripts/batch-rescore.ts`

**Changes:**
- Implement `validateBatch()` function from spec section 3.8
- Check agreement rate >= 55%
- Check average score spread <= 12
- Check needsReview count <= 15%
- Check failure rate <= 5%
- Stop processing if validation fails
- Log validation results

**VERIFY:** Validation gate correctly stops on poor metrics

---

### Task 5.2: Add Version Tracking to Scored Files

**ID:** 5.2
**Complexity:** S (< 30 min)
**Depends on:** 5.1a
**Parallel:** No

**Description:** Ensure scored files preserve previous scores for rollback capability.

**Files touched:**
- `/Users/tompryor/Broadwayscore/scripts/batch-rescore.ts`
- `/Users/tompryor/Broadwayscore/scripts/llm-scoring/ensemble-scorer.ts`

**Changes:**
- Before overwriting, copy existing score to `llmMetadata.previousScore`
- Copy existing version to `llmMetadata.previousVersion`
- Set `llmMetadata.promptVersion` to '5.0.0'

**VERIFY:** Rescored files contain both current and previous scores

---

### Task 5.3: Run Batch 1 (Calibration Set)

**ID:** 5.3
**Complexity:** M (30-90 min)
**Depends on:** 5.1a, 5.1b, 5.2
**Parallel:** No

**Description:** Run first batch on calibration set with full validation.

**Files touched:**
- `/Users/tompryor/Broadwayscore/data/review-texts/**/*.json` (updated)
- `/Users/tompryor/Broadwayscore/data/batch-rescore-checkpoint.json` (NEW)

**Changes:**
- Run batch-rescore on 200 calibration reviews
- Validate metrics
- If pass, commit changes

**VERIFY:** Batch 1 metrics meet targets; checkpoint saved

---

### Task 5.4: Run Batches 2-5

**ID:** 5.4
**Complexity:** M (30-90 min)
**Depends on:** 5.3
**Parallel:** No

**Description:** Continue rescoring with spot checks.

**Files touched:**
- `/Users/tompryor/Broadwayscore/data/review-texts/**/*.json` (updated)

**Changes:**
- Run batches 2-5 (800 reviews)
- Quick validation after each
- Stop if degradation detected
- Commit after each successful batch

**VERIFY:** All batches pass validation gates

---

### Task 5.5: Run Remaining Batches

**ID:** 5.5
**Complexity:** M (30-90 min)
**Depends on:** 5.4
**Parallel:** No

**Description:** Complete rescoring for remaining reviews.

**Files touched:**
- `/Users/tompryor/Broadwayscore/data/review-texts/**/*.json` (updated)

**Changes:**
- Run batches 6-10+ until complete
- Spot check validation
- Final commit

**VERIFY:** All reviews rescored; overall metrics meet targets

---

**Sprint 5 Demo:** Show batch processing with validation gate checking and successful completion.

---

## Sprint 6: Cleanup, Hardening & Deployment

**Sprint Goal:** Final validation, cleanup, and production deployment with monitoring.

**Risk Flags:**
- May discover edge cases in full dataset
- Need to update documentation

### Task 6.1: Review Flagged Items

**ID:** 6.1
**Complexity:** M (30-90 min)
**Depends on:** 5.5
**Parallel:** Yes (with 6.2)

**Description:** Review all items flagged with `needsReview: true`.

**Files touched:**
- `/Users/tompryor/Broadwayscore/data/review-texts/**/*.json` (updated)

**Changes:**
- Generate report of all flagged reviews
- Review top 50 manually
- Fix obvious scoring errors
- Document patterns for future improvement

**VERIFY:** Flagged item count <= 100 (5% of ~2000)

---

### Task 6.2: Compare Old vs New Scores

**ID:** 6.2
**Complexity:** M (30-90 min)
**Depends on:** 5.5
**Parallel:** Yes (with 6.1)

**Description:** Analyze score changes from v4 to v5.

**Files touched:**
- `/Users/tompryor/Broadwayscore/data/score-migration-report.json` (NEW)

**Changes:**
- Calculate delta between previousScore and new score for all reviews
- Flag reviews with >20 point change
- Generate distribution report
- Identify any systematic shifts

**VERIFY:** Report generated; no unexpected systematic shifts

---

### Task 6.3: Manual Review of Big Changes

**ID:** 6.3
**Complexity:** M (30-90 min)
**Depends on:** 6.2
**Parallel:** No

**Description:** Manually review reviews with >20 point score change.

**Files touched:**
- `/Users/tompryor/Broadwayscore/data/review-texts/**/*.json` (potentially updated)

**Changes:**
- Review each >20 point change
- Verify new score is correct
- Revert if v4 was actually correct
- Document findings

**VERIFY:** All >20 point changes verified or reverted

---

### Task 6.4: Update Workflow for Production

**ID:** 6.4
**Complexity:** S (< 30 min)
**Depends on:** 6.1, 6.2, 6.3
**Parallel:** No

**Description:** Finalize GitHub Actions workflow for production use.

**Files touched:**
- `/Users/tompryor/Broadwayscore/.github/workflows/llm-ensemble-score.yml`

**Changes:**
- Ensure all 3 API keys are used
- Add batch support options
- Update commit message for v5
- Add monitoring/alerting for failures

**VERIFY:** Workflow runs successfully with all options

---

### Task 6.5: Update Documentation

**ID:** 6.5
**Complexity:** S (< 30 min)
**Depends on:** 6.4
**Parallel:** No

**Description:** Update CLAUDE.md and related docs with new scoring system info.

**Files touched:**
- `/Users/tompryor/Broadwayscore/CLAUDE.md`
- `/Users/tompryor/Broadwayscore/.github/workflows/CLAUDE.md`

**Changes:**
- Document 3-model ensemble approach
- Update secrets table with GEMINI_API_KEY
- Document calibration process
- Update workflow descriptions

**VERIFY:** Documentation accurately reflects v5 implementation

---

**Sprint 6 Demo:** Show production workflow running, documentation updated, and metrics dashboard.

---

## Dependencies Graph

```
Sprint 1 (Foundation)
1.1 ──┐
1.2 ──┼──> 2.1, 2.4
1.3 ──┼──> 2.2, 2.4, 3.1
1.4 ──┘
1.5 (parallel)
1.6 ──> needs 1.3, 1.4

Sprint 2 (Ensemble)
2.1 ──> 2.4
2.2 ──> 2.3 ──> 2.4
2.4 ──> 2.5 ──> 3.1, 3.5

Sprint 3 (Pre-flight)
3.1 ──> 3.4
3.2 ──> 3.3
3.3 ──> 3.5
3.4 ──> 4.1
3.5 ──> 4.1

Sprint 4 (Calibration)
4.1 ──> 4.2 ──> 4.3 ──> 4.4
4.4 ──> 5.1a, 5.1b

Sprint 5 (Batch Rescore)
5.1a ──┐
5.1b ──┼──> 5.2 ──> 5.3 ──> 5.4 ──> 5.5
5.5 ──> 6.1, 6.2

Sprint 6 (Cleanup)
6.1 ──┐
6.2 ──┼──> 6.3 ──> 6.4 ──> 6.5
```

---

## Parallel Execution Map

| Workstream A | Workstream B | Notes |
|-------------|--------------|-------|
| 1.1 (types) | 1.2 (config) | Both are independent foundation work |
| 1.3 (Gemini scorer) | 1.4 (npm package), 1.5 (workflow) | All independent |
| 2.1 (input builder) | 2.2 (ensemble logic) | Both independent |
| 3.1 (preflight script) | 3.2 (calibration selector) | Independent until execution |
| 5.1a (batch core) | 5.1b (validation gates) | Merge after both complete |
| 6.1 (flagged review) | 6.2 (score comparison) | Independent analysis |

**Maximum parallelism:** 3 concurrent tasks in Sprint 1

---

## Known Edge Cases

1. **Gemini markdown wrapping** - May wrap JSON in ```json fences; parser handles this
2. **Gemini case variation** - May return "positive" instead of "Positive"; normalizer handles
3. **Network failures during batch** - Checkpoint/resume capability required
4. **Rate limiting** - 3 models = 3x API calls; may need throttling
5. **Score outside bucket range** - Clamp to bucket bounds
6. **All 3 models fail** - Mark review as `needsRescore: true`
7. **Truncated text with no excerpts** - Still score but with low confidence
8. **Historical reviews without thumbs** - No aggregator context provided

---

## Key Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Gemini has >10pt systematic bias | Medium | High | Calibration offset tuning |
| Batch rescore causes data loss | Low | High | Version tracking, backups |
| API costs exceed budget | Medium | Medium | Batch limits, monitoring |
| 3-model agreement < 55% | Low | High | May need to adjust thresholds or prompts |
| Calibration set not representative | Medium | Medium | Stratification by bucket + tier |

---

## Changes from Critique Review

1. **Broke down Task 5.1** - Originally "L" complexity, now split into 5.1a (core logic) and 5.1b (validation gates)
2. **Added explicit VERIFY steps** - Each task now has concrete verification criteria
3. **Added parallel execution map** - Clearer guidance on what can run concurrently
4. **Added edge cases section** - Documented known gotchas
5. **Added version tracking** - Task 5.2 ensures rollback capability
6. **Added checkpoint/resume** - Task 5.1a includes resume capability for long-running batches

---

## Success Criteria (from Phase 3 spec)

| Metric | Current | Target |
|--------|---------|--------|
| Thumb match rate | 69% | >= 85% |
| 3-model consensus | N/A | >= 60% |
| 2-model consensus | ~85% | >= 92% |
| Reviews flagged for review | 0 | <= 100 (5%) |
| Severe bucket errors | ~8% | <= 3% |
| Average score spread (agreeing models) | N/A | <= 8 pts |

---

## Appendix: Files Summary

### New Files
- `scripts/llm-scoring/gemini-scorer.ts`
- `scripts/llm-scoring/input-builder.ts`
- `scripts/llm-scoring/ensemble.ts`
- `scripts/llm-scoring/test-gemini.ts`
- `scripts/llm-scoring/preflight-test.ts`
- `scripts/build-calibration-set.ts`
- `scripts/calibrate-ensemble.ts`
- `scripts/batch-rescore.ts`
- `tests/unit/ensemble.test.ts`
- `data/calibration/calibration-set-200.json`
- `data/calibration/calibration-results.json`
- `data/calibration/CALIBRATION-REPORT.md`
- `data/batch-rescore-checkpoint.json`
- `data/score-migration-report.json`

### Modified Files
- `scripts/llm-scoring/types.ts`
- `scripts/llm-scoring/config.ts`
- `scripts/llm-scoring/ensemble-scorer.ts`
- `scripts/llm-scoring/index.ts`
- `.github/workflows/llm-ensemble-score.yml`
- `package.json`
- `CLAUDE.md`
- `.github/workflows/CLAUDE.md`
