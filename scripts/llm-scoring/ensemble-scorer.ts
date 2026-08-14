/**
 * Ensemble Scorer Module v5
 *
 * Combines Claude Sonnet + GPT-4o + Gemini 1.5 Pro for robust scoring through triangulation.
 * Uses bucket-first approach with graceful degradation (3→2→1 model fallback).
 */

import { ReviewScorer } from './scorer';
import { OpenAIReviewScorer } from './openai-scorer';
import { GeminiScorer } from './gemini-scorer';
import { KimiScorer } from './kimi-scorer';
import { ReviewTextFile, ScoredReviewFile, SimplifiedLLMResult, ModelScore, EnsembleResult as EnsembleResultType } from './types';
import { PROMPT_VERSION, buildPromptV5, SYSTEM_PROMPT_V5, buildSystemPromptV6, clampScoreToBand, ScoreBand } from './config';
import { buildScoringInput, ReviewInputData, ScoringInput } from './input-builder';
const { EXCERPT_FIELDS } = require('../lib/excerpt-fields');
const { GPT4O, GPT54_MINI } = require('../lib/models');
const { detectBandFromReviewFile, shouldUseAnchoredMode } = require('../lib/star-reliability');
import { ensembleScore, toModelScore } from './ensemble';

// ========================================
// TYPES
// ========================================

export interface EnsembleScoringOptions {
  claudeModel: 'claude-sonnet-4-6' | 'claude-3-5-haiku-20241022';
  openaiModel: 'gpt-4o-mini' | 'gpt-4o' | 'gpt-5.4-mini';
  geminiModel: 'gemini-2.5-flash' | 'gemini-2.5-flash' | 'gemini-1.5-flash';
  kimiModel: string;
  maxDelta: number;  // Maximum acceptable difference between models
  verbose: boolean;
  useV5Prompt: boolean;  // Use simplified bucket-first prompt
  // Anchored-band scoring (Phase B / S1-T6, 2026-05-01).
  // When `band` is set on a per-call basis (via scoreReview's third arg),
  // the V6 prompt is built with a hard band constraint and the ensemble
  // result is clamped post-hoc into [band.floor, band.ceiling]. Default
  // OFF — ensemble continues using V5 prompt + no clamp.
  // Note: Kimi scorer does not yet support systemPromptOverride. When
  // a band is set, Kimi is skipped (3-model ensemble) to prevent it
  // from voting against V6-prompted siblings using V5 rubric. Add Kimi
  // override + remove this skip in a follow-up before Phase 4 rescore.
}

/**
 * One model's outcome for one review — the shape scoreReview()'s internal
 * Promise.all produces, and the shape the --batch path reconstructs from a
 * vendor Batch API result line via parseBatchResponseV5() (task #516).
 */
export interface ModelOutcome {
  model: 'claude' | 'openai' | 'gemini' | 'kimi';
  result: SimplifiedLLMResult | null;
  error?: string;
  rejected?: boolean;
  rejection?: string;
  rejectionReasoning?: string;
}

/**
 * Everything scoreReviewFile() derives from a review file BEFORE any model
 * call — the prompt input, the anchored-band decision, and the V6 system
 * prompt override. In --batch mode this is computed at submit time (and
 * recomputed deterministically at merge time on resume) so the batch path
 * scores the exact same text/context/prompt the sync path would.
 */
export interface PreparedScoringInput {
  scoringInput: ScoringInput;
  band?: ScoreBand;
  starsRaw?: string;
  anchoredBandScoreSource: 'anchored-v6' | 'llm-v6' | null;
  /** buildSystemPromptV6(band, starsRaw) when band is set, else undefined. */
  systemPromptOverride?: string;
}

/**
 * prepareScoringInput()'s return. Not a discriminated union: scripts/tsconfig
 * runs with `strict: false`, where narrowing on a boolean literal discriminant
 * is not applied, so both members are optional and callers branch on `ok`.
 */
export interface PrepareScoringResult {
  ok: boolean;
  /** Set when ok — the prepared prompt input + anchored-band decision. */
  prep?: PreparedScoringInput;
  /** Set when !ok — the exact {success:false,...} scoreReviewFile used to return. */
  failure?: ScoreReviewFileResult;
}

/** Result shape shared by scoreReviewFile() and the --batch finalize path. */
export interface ScoreReviewFileResult {
  success: boolean;
  scoredFile?: ScoredReviewFile;
  ensembleResult?: EnsembleResultType;
  rejected?: boolean;
  rejection?: string;
  rejectionReasoning?: string;
  error?: string;
  inputValidationFailed?: boolean;
}

// ========================================
// ENSEMBLE SCORER
// ========================================

export class EnsembleReviewScorer {
  private claudeScorer: ReviewScorer;
  private openaiScorer: OpenAIReviewScorer;
  private geminiScorer: GeminiScorer | null;
  private kimiScorer: KimiScorer | null;
  private options: EnsembleScoringOptions;
  private modelCount: 2 | 3 | 4;

  constructor(
    claudeApiKey: string,
    openaiApiKey: string,
    geminiApiKey?: string,
    openrouterApiKey?: string,
    options: Partial<EnsembleScoringOptions> = {}
  ) {
    this.options = {
      claudeModel: options.claudeModel || 'claude-sonnet-4-6',
      // NOT swapped to GPT54_MINI: task #504 A/B (n=24 real reviews, 2026-07-26)
      // failed the rule-13 gate hard — Mixed bucket collapsed 29%->0%, max bucket
      // shift 29.2pp (limit 5pp). gpt-5.4-mini polarizes scores away from the
      // middle instead of just being a cheaper gpt-4o. Keep gpt-4o as the
      // scoring-path default; GPT54_MINI stays wired for --openai-model= testing
      // once the V5 prompt is recalibrated for it. See card #504 for the full readout.
      openaiModel: options.openaiModel || GPT4O,
      geminiModel: options.geminiModel || 'gemini-2.5-flash',
      kimiModel: options.kimiModel || 'moonshotai/kimi-k2.5',
      maxDelta: options.maxDelta ?? 15,
      verbose: options.verbose ?? false,
      useV5Prompt: options.useV5Prompt ?? true
    };

    this.claudeScorer = new ReviewScorer(claudeApiKey, {
      model: this.options.claudeModel,
      verbose: this.options.verbose
    });

    this.openaiScorer = new OpenAIReviewScorer(openaiApiKey, {
      model: this.options.openaiModel,
      verbose: this.options.verbose
    });

    // Gemini is optional - enables 3-model mode if provided
    if (geminiApiKey) {
      this.geminiScorer = new GeminiScorer(geminiApiKey, {
        model: this.options.geminiModel,
        verbose: this.options.verbose
      });
    } else {
      this.geminiScorer = null;
    }

    // Kimi via OpenRouter is optional - enables 4-model mode if provided
    if (openrouterApiKey) {
      this.kimiScorer = new KimiScorer(openrouterApiKey, {
        model: this.options.kimiModel,
        verbose: this.options.verbose
      });
    } else {
      this.kimiScorer = null;
    }

    this.modelCount = 2 + (this.geminiScorer ? 1 : 0) + (this.kimiScorer ? 1 : 0) as 2 | 3 | 4;
  }

  /**
   * Get the number of models in use
   */
  getModelCount(): 2 | 3 | 4 {
    return this.modelCount;
  }

  /**
   * Model IDs + which legs are live — needed by --batch mode (task #516) to
   * build per-vendor batch requests that name the SAME models the sync path
   * would call. `kimiEnabled` is surfaced so the batch runner can refuse to
   * run rather than silently score a 3-model ensemble where sync would have
   * used 4 (no vendor batch tier exists for OpenRouter/Kimi).
   */
  getBatchConfig(): {
    claudeModel: string;
    openaiModel: string;
    geminiModel: string;
    geminiEnabled: boolean;
    geminiTemperature: number;
    kimiEnabled: boolean;
  } {
    return {
      claudeModel: this.options.claudeModel,
      openaiModel: this.options.openaiModel,
      geminiModel: this.options.geminiModel,
      geminiEnabled: !!this.geminiScorer,
      // Threaded explicitly: Gemini's temperature is the one ensemble knob
      // that is configurable at construction, so batch must not assume 0.3.
      geminiTemperature: this.geminiScorer ? this.geminiScorer.getTemperature() : 0.3,
      kimiEnabled: !!this.kimiScorer,
    };
  }

  /**
   * The per-vendor scorer instances, so --batch mode can run each vendor's
   * raw batch response text through that vendor's own parseBatchResponseV5()
   * — the same rejection-check + parse + calibration-offset pipeline the
   * live sync call uses (Gemini's, notably, applies GEMINI_CALIBRATION_OFFSET
   * inside validateAndNormalize).
   */
  getScorers(): {
    claude: ReviewScorer;
    openai: OpenAIReviewScorer;
    gemini: GeminiScorer | null;
  } {
    return { claude: this.claudeScorer, openai: this.openaiScorer, gemini: this.geminiScorer };
  }

  /**
   * Fold Batch API usage counters into the per-scorer token totals so the
   * end-of-run cost print and run summary see batch tokens exactly as they
   * see sync tokens. Batch results carry usage per item; the sync path
   * accumulates it inside each scoreReviewV5 call.
   */
  recordBatchUsage(usage: {
    claude?: { input: number; output: number; cacheWrite?: number; cacheRead?: number };
    openai?: { input: number; output: number };
    gemini?: { input: number; output: number };
  }): void {
    if (usage.claude) this.claudeScorer.recordBatchUsage(usage.claude);
    if (usage.openai) this.openaiScorer.recordBatchUsage(usage.openai);
    if (usage.gemini && this.geminiScorer) this.geminiScorer.recordBatchUsage(usage.gemini);
  }

  /**
   * Score a review using all available models and combine results.
   *
   * Optional band (3rd arg) activates V6 anchored-mode scoring:
   *   - V6 system prompt built with hard band constraint, passed to per-model
   *     scoreReviewV5 calls via systemPromptOverride
   *   - Ensemble result clamped post-hoc into [band.floor, band.ceiling]
   *   - Kimi skipped (lacks systemPromptOverride; voting V5 rubric against
   *     V6-prompted siblings would skew the ensemble)
   *
   * @param reviewText - the review prose to score
   * @param context    - context block for the user prompt
   * @param band       - optional anchored-mode band (S1-T6, default OFF)
   * @param starsRaw   - optional raw rating string for context in the prompt
   */
  async scoreReview(
    reviewText: string,
    context: string = '',
    band?: ScoreBand,
    starsRaw?: string
  ): Promise<EnsembleResultType> {
    // Anchored mode: build V6 prompt and pass as override to scorers that
    // support it. Default unanchored = V5 in-place.
    const systemPromptOverride = band
      ? buildSystemPromptV6(band, starsRaw)
      : undefined;

    // Build promises for all available models
    const promises: Promise<ModelOutcome>[] = [];

    // Claude
    promises.push(
      this.claudeScorer.scoreReviewV5(reviewText, context, systemPromptOverride)
        .then(outcome => ({
          model: 'claude' as const,
          result: outcome.success && !outcome.rejected ? outcome.result! : null,
          error: outcome.error,
          rejected: outcome.rejected,
          rejection: outcome.rejection,
          rejectionReasoning: outcome.rejectionReasoning
        }))
        .catch(err => ({
          model: 'claude' as const,
          result: null,
          error: err.message
        }))
    );

    // OpenAI
    promises.push(
      this.openaiScorer.scoreReviewV5(reviewText, context, systemPromptOverride)
        .then(outcome => ({
          model: 'openai' as const,
          result: outcome.success && !outcome.rejected ? outcome.result! : null,
          error: outcome.error,
          rejected: outcome.rejected,
          rejection: outcome.rejection,
          rejectionReasoning: outcome.rejectionReasoning
        }))
        .catch(err => ({
          model: 'openai' as const,
          result: null,
          error: err.message
        }))
    );

    // Gemini (if available)
    if (this.geminiScorer) {
      promises.push(
        this.geminiScorer.scoreReview(reviewText, context, systemPromptOverride)
          .then(outcome => ({
            model: 'gemini' as const,
            result: outcome.success && !outcome.rejected ? outcome.result! : null,
            error: outcome.error,
            rejected: outcome.rejected,
            rejection: outcome.rejection,
            rejectionReasoning: outcome.rejectionReasoning
          }))
          .catch(err => ({
            model: 'gemini' as const,
            result: null,
            error: err.message
          }))
      );
    }

    // Kimi via OpenRouter (if available AND not in band-anchored mode).
    // Kimi lacks systemPromptOverride support — including it in band mode
    // would mean Kimi votes V5-rubric against V6-prompted siblings, skewing
    // the ensemble. Add override support to kimi-scorer.ts to remove this
    // skip before Phase 4 full rescore.
    if (this.kimiScorer && !band) {
      promises.push(
        this.kimiScorer.scoreReview(reviewText, context)
          .then(outcome => ({
            model: 'kimi' as const,
            result: outcome.success && !outcome.rejected ? outcome.result! : null,
            error: outcome.error,
            rejected: outcome.rejected,
            rejection: outcome.rejection,
            rejectionReasoning: outcome.rejectionReasoning
          }))
          .catch(err => ({
            model: 'kimi' as const,
            result: null,
            error: err.message
          }))
      );
    }

    // Run all models in parallel
    const results = await Promise.all(promises);

    return this.combineOutcomes(results, band);
  }

  /**
   * Combine per-model outcomes into a single EnsembleResult.
   *
   * Extracted verbatim from the tail of scoreReview() (task #516) so the
   * --batch path — whose per-model outcomes arrive from vendor Batch APIs
   * hours later instead of from live Promise.all — runs the IDENTICAL
   * rejection-consensus / toModelScore / ensembleScore / band-clamp logic.
   * scoreReview() itself now calls this, so there is exactly one
   * implementation and sync/batch parity is structural, not merely tested.
   */
  combineOutcomes(results: ModelOutcome[], band?: ScoreBand): EnsembleResultType {
    // Check for rejection consensus (v5.2+)
    const rejections = results.filter(r => r.rejected);
    const totalModels = results.length;

    if (rejections.length >= 2) {
      // 2/3 or 3/3 models rejected — consensus rejection
      const primaryRejection = rejections[0];
      const rejectionResult: EnsembleResultType = {
        score: 0,
        bucket: 'Pan',
        confidence: 'high',
        source: 'ensemble-unanimous',
        rejected: true,
        rejection: primaryRejection.rejection,
        rejectionReasoning: rejections.map(r => `${r.model}: ${r.rejectionReasoning}`).join('; '),
        modelResults: {},
        needsReview: false,
        note: `${rejections.length}/${totalModels} models rejected as ${primaryRejection.rejection}`
      };

      if (this.options.verbose) {
        console.log(`  Ensemble REJECTED: ${primaryRejection.rejection} (${rejections.length}/${totalModels} models)`);
        for (const r of rejections) {
          console.log(`    ${r.model}: ${r.rejectionReasoning}`);
        }
      }

      return rejectionResult;
    }

    // Convert to ModelScore format (treat rejectors as failed)
    const claudeOutcome = results.find(r => r.model === 'claude');
    const openaiOutcome = results.find(r => r.model === 'openai');
    const geminiOutcome = results.find(r => r.model === 'gemini');
    const kimiOutcome = results.find(r => r.model === 'kimi');

    const claudeScore = claudeOutcome
      ? toModelScore(
          claudeOutcome.rejected ? null : claudeOutcome.result,
          'claude',
          claudeOutcome.rejected ? 'Rejected as unscorable' : claudeOutcome.error
        )
      : null;
    const openaiScore = openaiOutcome
      ? toModelScore(
          openaiOutcome.rejected ? null : openaiOutcome.result,
          'openai',
          openaiOutcome.rejected ? 'Rejected as unscorable' : openaiOutcome.error
        )
      : null;
    const geminiScore = geminiOutcome
      ? toModelScore(
          geminiOutcome.rejected ? null : geminiOutcome.result,
          'gemini',
          geminiOutcome.rejected ? 'Rejected as unscorable' : geminiOutcome.error
        )
      : null;
    const kimiScore = kimiOutcome
      ? toModelScore(
          kimiOutcome.rejected ? null : kimiOutcome.result,
          'kimi',
          kimiOutcome.rejected ? 'Rejected as unscorable' : kimiOutcome.error
        )
      : null;

    // Use ensemble voting logic
    const ensembleResult = ensembleScore(claudeScore, openaiScore, geminiScore, kimiScore);

    // S1-T6: Anchored-mode post-hoc clamp. The V6 prompt already instructs
    // the LLM to score within the band, but defensively clamp the ensemble
    // output here so a single rogue model can't pull the consensus outside
    // the critic's stated band. No-op when no band passed.
    if (band && typeof ensembleResult.score === 'number' && !ensembleResult.rejected) {
      const raw = ensembleResult.score;
      const clamped = clampScoreToBand(raw, band);
      if (clamped !== raw) {
        ensembleResult.score = clamped;
        if (this.options.verbose) {
          console.log(`  Anchored-mode clamp: ${raw} → ${clamped} (band [${band.floor},${band.ceiling}])`);
        }
      }
    }

    if (this.options.verbose) {
      this.logVerbose(ensembleResult);
    }

    return ensembleResult;
  }

  /**
   * Score a review file and return updated content.
   *
   * Composed of three extracted stages (task #516) — prepareScoringInput →
   * scoreReview → finalizeScoredFile — so --batch mode can run stage 1 at
   * submit time, get stage 2's model outcomes from a vendor Batch API, and
   * run stage 3 unchanged. Same functions, one implementation.
   */
  async scoreReviewFile(reviewFile: ReviewTextFile): Promise<ScoreReviewFileResult> {
    const prepared = this.prepareScoringInput(reviewFile);
    if (!prepared.ok || !prepared.prep) {
      // `failure` is optional on PrepareScoringResult (the type is not a
      // discriminated union — see the note on that interface), so give the
      // caller a real result rather than `undefined` under strictNullChecks.
      return prepared.failure || { success: false, error: 'prepare_scoring_input_failed' };
    }
    const prep = prepared.prep;

    // Score with ensemble
    const ensembleResult = await this.scoreReview(
      prep.scoringInput.text,
      prep.scoringInput.context,
      prep.band,
      prep.starsRaw,
    );

    return this.finalizeScoredFile(reviewFile, ensembleResult, prep);
  }

  /**
   * Stage 1 (extracted from the head of scoreReviewFile, task #516): build
   * the scoring input, run pre-scoring input validation, and decide the
   * anchored-band mode. Pure with respect to the network — makes no model
   * call — so --batch can call it at submit time and (on resume) recompute
   * it deterministically from the same review file at merge time.
   */
  prepareScoringInput(reviewFile: ReviewTextFile): PrepareScoringResult {
    // Build rich input context using input-builder
    // Pass all excerpt fields dynamically from canonical EXCERPT_FIELDS list
    // so new aggregator sources don't require manual mapping here
    const excerptData: Record<string, string | null> = {};
    for (const field of EXCERPT_FIELDS) {
      excerptData[field] = (reviewFile as any)[field] ?? null;
    }

    const reviewData: ReviewInputData = {
      showId: reviewFile.showId,
      showTitle: reviewFile.showTitle,
      outletId: reviewFile.outletId,
      outlet: reviewFile.outlet,
      criticName: reviewFile.criticName,
      publishDate: reviewFile.publishDate,
      // category + venue MUST be propagated: input-builder.ts uses these to
      // emit the market label ("West End", "Off-Broadway", etc.) in the
      // context block. When omitted, input-builder falls through to the
      // "Broadway" default, which made the LLM ensemble reject genuine WE
      // reviews with "show context specifies Broadway" reasoning.
      // Discovered 2026-04-23 (Notion 34b637c5-416f-81ad-8afb-e39b9de9e926)
      // after 4 audit B-class false-positives traced to this omission.
      // index.ts:1070-1071 attaches these fields to reviewFile before
      // calling the scorer — we just need to forward them.
      category: (reviewFile as any).category,
      venue: (reviewFile as any).venue,
      // type must be propagated so input-builder can frame opera shows as
      // "opera at the Met" rather than "Off-Broadway theater". Without this,
      // the ensemble's wrong_show check rejects opera reviews because the
      // text clearly describes opera but the prompt says the show is
      // Off-Broadway theater. (2026-05-17 root fix for Onegin Haiku-fallback
      // incident — see Notion 363637c5-416f-81cc-8240-c48df8b4cfd2.)
      type: (reviewFile as any).type,
      // priorRuns must be propagated so input-builder can tell the model that
      // declared tour legs ARE this production. Without this the scoreability
      // check rejects every tour-venue review as wrong_production (The Car Man
      // 2026-08-02: 5 legit tour reviews rejected against "Sadler's Wells").
      // Third instance of the allowlist-omission class (category/venue
      // 2026-04-23, type 2026-05-17) — the parity unit test now guards it.
      priorRuns: (reviewFile as any).priorRuns,
      fullText: reviewFile.fullText,
      ...excerptData,
      bwwThumb: reviewFile.bwwThumb,
      bwwScore: (reviewFile as any).bwwScore ?? null,
      dtliThumb: (reviewFile as any).dtliThumb,
      originalScore: reviewFile.originalScore !== null ? String(reviewFile.originalScore) : null,
      originalRating: (reviewFile as any).originalRating
    };

    const scoringInput = buildScoringInput(reviewData);

    if (!scoringInput.text || scoringInput.text.length < 50) {
      return {
        ok: false,
        failure: {
          success: false,
          error: 'Review text too short or missing'
        }
      };
    }

    // Pre-scoring input validation: reject nav chrome and garbage before sending to LLM.
    // Prevents the TheaterMania incident (Proof 2026-04-16) where nav chrome was scored 95/Rave.
    const { validateScoreableText } = require('../lib/score-input-validator.js');
    const { isCapsuleReview } = require('../lib/scorable-text.js');
    // Theatre Record print capsules are complete short reviews — exempt from
    // the body-length gate like excerpts, without reclassifying textQuality
    // (the prompt keeps its truncated-text caution framing).
    const isExcerpt = scoringInput.textQuality === 'excerpt-only' || isCapsuleReview(reviewFile);
    const inputValidation = validateScoreableText(scoringInput.text, reviewFile.showTitle, { isExcerpt });
    if (!inputValidation.ok) {
      return {
        ok: false,
        failure: {
          success: false,
          error: `input_validation_failed:${inputValidation.reason}`,
          inputValidationFailed: true,
        }
      };
    }
    if (inputValidation.warnings && inputValidation.warnings.length > 0) {
      console.log(`  ::warning::Input validator warnings: ${inputValidation.warnings.join(', ')}`);
    }

    // Sprint 3 (S4): ANCHORED_BANDS_PILOT flag wiring. When env flag is ON,
    // detect the critic's star rating or letter grade and either:
    //   (a) HIGH-reliability star → ANCHORED mode (V6 prompt + band constraint)
    //   (b) LOW-reliability star → UNANCHORED mode (V6 prompt, no band — prose
    //       only, because the extraction itself may be wrong)
    //   (c) no star/grade detected → UNANCHORED mode
    //   (d) flag OFF → existing V5 behavior, untouched
    // The result is stamped with scoreSource='anchored-v6' or 'llm-v6' so
    // getBestScore() can identify which path produced the score.
    // Sprint W1-T4 (Phase B-WE): shouldUseAnchoredMode replaces inline flag
    // check. WE/OWE category auto-anchors (per src/config/scoring.ts
    // ANCHORED_MARKETS); other markets need ANCHORED_BANDS_PILOT=1.
    // Deny-list inside the helper: category=null/empty refuses to anchor,
    // even with envFlag=true (drift safety).
    const useAnchored = shouldUseAnchoredMode({
      category: (reviewFile as any).category,
      envFlag: process.env.ANCHORED_BANDS_PILOT === '1',
    });
    let band: ScoreBand | undefined = undefined;
    let starsRaw: string | undefined = undefined;
    let anchoredBandScoreSource: 'anchored-v6' | 'llm-v6' | null = null;
    if (useAnchored) {
      const detection = detectBandFromReviewFile(reviewFile);
      if (detection && detection.highReliability) {
        band = detection.band;
        starsRaw = detection.starsRaw;
        anchoredBandScoreSource = 'anchored-v6';
      } else {
        // No detection, low-reliability, or no star — unanchored V6 either way.
        anchoredBandScoreSource = 'llm-v6';
      }
    }

    return {
      ok: true,
      prep: {
        scoringInput,
        band,
        starsRaw,
        anchoredBandScoreSource,
        // Mirrors scoreReview()'s own derivation so the --batch request
        // carries the identical system prompt the sync call would send.
        systemPromptOverride: band ? buildSystemPromptV6(band, starsRaw) : undefined,
      },
    };
  }

  /**
   * Stage 3 (extracted from the tail of scoreReviewFile, task #516): turn an
   * EnsembleResult + the stage-1 prep into the ScoredReviewFile the caller
   * writes to disk. Runs the allModelsFailed guard, the hallucination guard,
   * the confidence cap, and the anchored-band stamping — all unchanged, so
   * a batch-derived ensemble result produces byte-identical output to a
   * synchronously-derived one.
   */
  finalizeScoredFile(
    reviewFile: ReviewTextFile,
    ensembleResult: EnsembleResultType,
    prep: PreparedScoringInput
  ): ScoreReviewFileResult {
    const { scoringInput, band, anchoredBandScoreSource } = prep;

    // Check for rejection (v5.2+)
    if (ensembleResult.rejected) {
      return {
        success: true,
        rejected: true,
        rejection: ensembleResult.rejection,
        rejectionReasoning: ensembleResult.rejectionReasoning,
        ensembleResult
      };
    }

    // Guard: refuse to write score=50 when ALL models failed. Previously this
    // returned {score: 50, needsReview: true} and the caller saved it silently.
    // On opening night with simultaneous rate limiting, every review would
    // collapse to "Mixed 50" and the composite score would be meaningless.
    // Now: return success:false with a clear error — caller skips and the
    // adjudication queue picks it up the next day.
    // (Postmortem audit fix #4.)
    if ((ensembleResult as any).allModelsFailed) {
      const stepSummary = process.env.GITHUB_STEP_SUMMARY;
      if (stepSummary) {
        try {
          const fs = require('fs');
          fs.appendFileSync(stepSummary,
            `\n## ⚠️ All LLM models failed for ${reviewFile.showId}/${reviewFile.outletId}\n\nAll 3 ensemble models errored. Review not scored. Check API rate limits.\n`);
        } catch {}
      }
      console.log(`::warning::ALL LLM models failed for ${reviewFile.showId}/${reviewFile.outletId} — refusing to write score=50, skipping`);
      return {
        success: false,
        error: 'All ensemble models failed — refusing to write fallback score=50',
        ensembleResult,
      };
    }

    // Post-scoring hallucination guard: if the LLM admitted it had no real review
    // content and invented a score, refuse to write the result.
    // The Proof incident: LLM reasoned "no actual review content... assuming
    // hypothetical positive review" — this catches that pattern.
    const { detectHallucinatedScore } = require('../lib/score-input-validator.js');
    const allReasonings = [
      ensembleResult.modelResults.claude?.reasoning,
      ensembleResult.modelResults.openai?.reasoning,
      ensembleResult.modelResults.gemini?.reasoning,
      ensembleResult.modelResults.kimi?.reasoning,
      ensembleResult.note,
    ].filter(Boolean).join(' | ');
    const hallucinationCheck = detectHallucinatedScore(allReasonings);
    if (hallucinationCheck.refused) {
      console.log(`::warning::Hallucinated score detected for ${reviewFile.showId}/${reviewFile.outletId} — refusing to write`);
      return {
        success: false,
        error: `hallucinated_score: LLM admitted scoring non-review content`,
        inputValidationFailed: true,
      } as any;
    }

    // Cap final confidence to the LOWER of ensemble agreement and input quality.
    // See scripts/lib/llm-confidence.js capLlmConfidence (extracted per CLAUDE.md §15
    // so the unit test in tests/unit/llm-confidence-cap.test.mjs requires the same
    // function — preventing test/prod drift).
    //
    // DoaS Apr 9-10 #14: Variety scored 73/Positive with high confidence from a
    // 180-char BWW excerpt; full review was Mixed (66) once we got the real text.
    // Operator escape hatch: reviewFile.confidenceOverride bypasses the cap.
    const { capLlmConfidence } = require('../lib/llm-confidence.js');
    const cappedConfidence = capLlmConfidence(
      ensembleResult.confidence,
      scoringInput.confidence,
      (reviewFile as any).confidenceOverride
    );

    // Build the scored file
    const scoredFile: ScoredReviewFile = {
      ...reviewFile,
      assignedScore: ensembleResult.score,
      llmScore: {
        score: ensembleResult.score,
        confidence: cappedConfidence,
        range: { low: ensembleResult.score - 5, high: ensembleResult.score + 5 },
        bucket: ensembleResult.bucket,
        thumb: ensembleResult.bucket === 'Rave' || ensembleResult.bucket === 'Positive' ? 'Up' :
               ensembleResult.bucket === 'Mixed' ? 'Flat' : 'Down',
        components: { book: null, music: null, performances: null, direction: null },
        // V5 scorers return keyQuote (single string); convert to keyPhrases array for pullQuote pipeline
        keyPhrases: (() => {
          const kq = ensembleResult.modelResults.claude?.keyQuote
            || ensembleResult.modelResults.openai?.keyQuote
            || ensembleResult.modelResults.gemini?.keyQuote
            || ensembleResult.modelResults.kimi?.keyQuote
            || '';
          return kq.length > 20 ? [{ quote: kq, sentiment: 'neutral' as const, strength: 3 }] : [];
        })(),
        reasoning: this.buildCombinedReasoning(ensembleResult),
        flags: {
          hasExplicitRecommendation: false,
          focusedOnPerformances: false,
          comparesToPrevious: false,
          mixedSignals: ensembleResult.needsReview || false
        }
      },
      llmMetadata: {
        model: `ensemble:${this.options.claudeModel}+${this.options.openaiModel}${this.geminiScorer ? `+${this.options.geminiModel}` : ''}${this.kimiScorer ? `+${this.options.kimiModel}` : ''}`,
        scoredAt: new Date().toISOString(),
        promptVersion: PROMPT_VERSION,
        inputTokens: 0,
        outputTokens: 0,
        previousScore: reviewFile.assignedScore ?? undefined,
        previousVersion: (reviewFile as any).llmMetadata?.promptVersion,
        textSource: {
          type: scoringInput.textQuality === 'excerpt-only' ? 'excerpt' as const : 'fullText' as const,
          status: scoringInput.textQuality,
          field: scoringInput.textQuality === 'excerpt-only' ? 'excerpt' : 'fullText',
          confidence: scoringInput.confidence,
          reasoning: scoringInput.reasoning
        }
      },
      ensembleData: {
        claudeScore: ensembleResult.modelResults.claude?.score ?? null,
        openaiScore: ensembleResult.modelResults.openai?.score ?? null,
        geminiScore: ensembleResult.modelResults.gemini?.score ?? null,
        kimiScore: ensembleResult.modelResults.kimi?.score ?? null,
        claudeBucket: ensembleResult.modelResults.claude?.bucket,
        openaiBucket: ensembleResult.modelResults.openai?.bucket,
        geminiBucket: ensembleResult.modelResults.gemini?.bucket,
        kimiBucket: ensembleResult.modelResults.kimi?.bucket,
        scoreDelta: this.calculateScoreDelta(ensembleResult),
        thumbsMatch: null, // TODO: Re-implement thumbs validation
        expectedThumb: null,
        needsReview: ensembleResult.needsReview || false,
        needsReviewReasons: ensembleResult.reviewReason ? [ensembleResult.reviewReason] : [],
        ensembleSource: ensembleResult.source,
        modelAgreement: ensembleResult.agreement,
        // Propagate emergency flag: 1-of-N model succeeded — score excluded from compositeScore
        ...(ensembleResult.singleModelEmergency ? { singleModelEmergency: true } : {}),
        // Which majority/outlier weight set produced this score (task #384 Phase B).
        // Written now so mixed v1/v2 batches are distinguishable on disk once
        // ENSEMBLE_V2 is ever flipped on — without this, rollback/debugging after
        // a live flag flip would have no record of which reviews used which weights.
        ...(ensembleResult.ensembleVersion ? { ensembleVersion: ensembleResult.ensembleVersion } : {}),
      }
    };

    // Sprint 3 (S4): stamp anchored-bands scoreSource + band metadata. Only
    // overwrites scoreSource when the flag is ON; otherwise existing
    // (originalScore-based) scoreSource on the file is preserved by spread.
    if (anchoredBandScoreSource) {
      (scoredFile as any).scoreSource = anchoredBandScoreSource;
      if (band) {
        (scoredFile.llmScore as any).band = {
          floor: band.floor,
          ceiling: band.ceiling,
          fraction: band.fraction,
        };
      }
    }

    // Extract publishDate from LLM if review doesn't already have one.
    // Take the first non-null date from any model (Claude > OpenAI > Gemini > Kimi).
    //
    // THIS DATE IS A GUESS, NOT AN EXTRACTION — do not treat it as authoritative.
    // It is a by-product of scoring: no URL segment, no dateline, no JSON-LD
    // behind it, and nothing downstream verifies it. The `!scoredFile.publishDate`
    // guard means a real date is never overwritten, but an invented one becomes
    // durable and is then indistinguishable on disk from a real one.
    //
    // A hallucinated year previously reached the ingest date-plausibility guard
    // and was read as proof of a different production — a phantom
    // wrongProduction that held main red. scripts/lib/date-plausibility.js now
    // ignores dateSource === 'llm-scoring' for exactly that reason; any NEW date
    // guard must do the same rather than trusting this field.
    //
    // Nulling this fill outright was considered and deliberately NOT done: with
    // no date at all these reviews fall to the dateless-revival guard
    // (scripts/lib/date-guard.js evaluateDatelessRevivalGuard, called from
    // rebuild-all-reviews.js), which WRITES wrongProduction: true for
    // multi-production titles that have not yet opened. That is a score-moving
    // behaviour change on the opening-night path and needs its own validation,
    // so the guard-side fix was taken first. If this fill is ever removed, size
    // that dateless-revival exposure before landing it.
    if (!scoredFile.publishDate) {
      const llmDate = ensembleResult.modelResults.claude?.publishDate
        || ensembleResult.modelResults.openai?.publishDate
        || ensembleResult.modelResults.gemini?.publishDate
        || ensembleResult.modelResults.kimi?.publishDate
        || null;
      if (llmDate) {
        scoredFile.publishDate = llmDate;
        (scoredFile as any).dateSource = 'llm-scoring';
      }
    }

    return {
      success: true,
      scoredFile,
      ensembleResult
    };
  }

  /**
   * Calculate score delta from ensemble result
   */
  private calculateScoreDelta(result: EnsembleResultType): number {
    const scores: number[] = [];

    if (result.modelResults.claude && !result.modelResults.claude.error) {
      scores.push(result.modelResults.claude.score);
    }
    if (result.modelResults.openai && !result.modelResults.openai.error) {
      scores.push(result.modelResults.openai.score);
    }
    if (result.modelResults.gemini && !result.modelResults.gemini.error) {
      scores.push(result.modelResults.gemini.score);
    }
    if (result.modelResults.kimi && !result.modelResults.kimi.error) {
      scores.push(result.modelResults.kimi.score);
    }

    if (scores.length < 2) return 0;

    return Math.max(...scores) - Math.min(...scores);
  }

  /**
   * Build combined reasoning from model results
   */
  private buildCombinedReasoning(result: EnsembleResultType): string {
    const parts: string[] = [];

    // Add ensemble summary
    parts.push(`[${result.source}]`);

    if (result.agreement) {
      parts.push(result.agreement);
    }

    // Add individual model reasoning if available
    const modelResults = result.modelResults;

    if (modelResults.claude?.reasoning) {
      parts.push(`Claude: ${modelResults.claude.reasoning}`);
    }
    if (modelResults.openai?.reasoning) {
      parts.push(`OpenAI: ${modelResults.openai.reasoning}`);
    }
    if (modelResults.gemini?.reasoning) {
      parts.push(`Gemini: ${modelResults.gemini.reasoning}`);
    }
    if (modelResults.kimi?.reasoning) {
      parts.push(`Kimi: ${modelResults.kimi.reasoning}`);
    }

    if (result.note) {
      parts.push(result.note);
    }

    return parts.join(' | ');
  }

  /**
   * Log verbose output
   */
  private logVerbose(result: EnsembleResultType): void {
    console.log(`  Ensemble: ${result.source}`);
    console.log(`    Claude: ${result.modelResults.claude?.bucket || 'N/A'} (${result.modelResults.claude?.score ?? 'N/A'})`);
    console.log(`    OpenAI: ${result.modelResults.openai?.bucket || 'N/A'} (${result.modelResults.openai?.score ?? 'N/A'})`);
    if (result.modelResults.gemini !== undefined) {
      console.log(`    Gemini: ${result.modelResults.gemini?.bucket || 'N/A'} (${result.modelResults.gemini?.score ?? 'N/A'})`);
    }
    if (result.modelResults.kimi !== undefined) {
      console.log(`    Kimi:   ${result.modelResults.kimi?.bucket || 'N/A'} (${result.modelResults.kimi?.score ?? 'N/A'})`);
    }
    console.log(`    Final: ${result.bucket} (${result.score}) [${result.confidence}]`);
    if (result.outlier) {
      console.log(`    Outlier: ${result.outlier.model} chose ${result.outlier.bucket}`);
    }
    if (result.needsReview) {
      console.log(`    ⚠️  Needs review: ${result.reviewReason}`);
    }
  }

  /**
   * Get combined token usage from all models
   */
  getTokenUsage(): {
    claude: { input: number; output: number; cacheWrite: number; cacheRead: number };
    openai: { input: number; output: number };
    gemini: { input: number; output: number } | null;
    kimi: { input: number; output: number } | null;
    total: number;
  } {
    const claudeUsage = this.claudeScorer.getTokenUsage();
    const openaiUsage = this.openaiScorer.getTokenUsage();
    const geminiUsage = this.geminiScorer?.getTokenUsage() || null;
    const kimiUsage = this.kimiScorer?.getTokenUsage() || null;

    const total = claudeUsage.total + openaiUsage.total + (geminiUsage?.total || 0) + (kimiUsage?.total || 0);

    return {
      claude: {
        input: claudeUsage.input,
        output: claudeUsage.output,
        // Anthropic prompt-cache tokens (excluded from input) — needed by
        // cost.ts so --max-cost and the end-of-run print stay accurate.
        cacheWrite: claudeUsage.cacheWrite,
        cacheRead: claudeUsage.cacheRead
      },
      openai: { input: openaiUsage.input, output: openaiUsage.output },
      gemini: geminiUsage ? { input: geminiUsage.input, output: geminiUsage.output } : null,
      kimi: kimiUsage ? { input: kimiUsage.input, output: kimiUsage.output } : null,
      total
    };
  }

  resetTokenUsage(): void {
    this.claudeScorer.resetTokenUsage();
    this.openaiScorer.resetTokenUsage();
    this.geminiScorer?.resetTokenUsage();
    this.kimiScorer?.resetTokenUsage();
  }
}
