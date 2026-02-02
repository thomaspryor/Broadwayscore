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
import { PROMPT_VERSION, buildPromptV5, SYSTEM_PROMPT_V5 } from './config';
import { buildScoringInput, ReviewInputData } from './input-builder';
import { ensembleScore, toModelScore } from './ensemble';

// ========================================
// TYPES
// ========================================

export interface EnsembleScoringOptions {
  claudeModel: 'claude-sonnet-4-20250514' | 'claude-3-5-haiku-20241022';
  openaiModel: 'gpt-4o-mini' | 'gpt-4o';
  geminiModel: 'gemini-2.0-flash' | 'gemini-1.5-flash';
  kimiModel: string;
  maxDelta: number;  // Maximum acceptable difference between models
  verbose: boolean;
  useV5Prompt: boolean;  // Use simplified bucket-first prompt
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
      claudeModel: options.claudeModel || 'claude-sonnet-4-20250514',
      openaiModel: options.openaiModel || 'gpt-4o',
      geminiModel: options.geminiModel || 'gemini-2.0-flash',
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
   * Score a review using all available models and combine results
   */
  async scoreReview(
    reviewText: string,
    context: string = ''
  ): Promise<EnsembleResultType> {
    // Build promises for all available models
    const promises: Promise<{
      model: 'claude' | 'openai' | 'gemini' | 'kimi';
      result: SimplifiedLLMResult | null;
      error?: string;
      rejected?: boolean;
      rejection?: string;
      rejectionReasoning?: string;
    }>[] = [];

    // Claude
    promises.push(
      this.claudeScorer.scoreReviewV5(reviewText, context)
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
      this.openaiScorer.scoreReviewV5(reviewText, context)
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
        this.geminiScorer.scoreReview(reviewText, context)
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

    // Kimi via OpenRouter (if available)
    if (this.kimiScorer) {
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

    if (this.options.verbose) {
      this.logVerbose(ensembleResult);
    }

    return ensembleResult;
  }

  /**
   * Score a review file and return updated content
   */
  async scoreReviewFile(reviewFile: ReviewTextFile): Promise<{
    success: boolean;
    scoredFile?: ScoredReviewFile;
    ensembleResult?: EnsembleResultType;
    rejected?: boolean;
    rejection?: string;
    rejectionReasoning?: string;
    error?: string;
  }> {
    // Build rich input context using input-builder
    const reviewData: ReviewInputData = {
      showId: reviewFile.showId,
      outletId: reviewFile.outletId,
      outlet: reviewFile.outlet,
      criticName: reviewFile.criticName,
      publishDate: reviewFile.publishDate,
      fullText: reviewFile.fullText,
      bwwExcerpt: reviewFile.bwwExcerpt,
      dtliExcerpt: reviewFile.dtliExcerpt,
      showScoreExcerpt: reviewFile.showScoreExcerpt,
      nycTheatreExcerpt: (reviewFile as any).nycTheatreExcerpt,
      bwwThumb: reviewFile.bwwThumb,
      dtliThumb: (reviewFile as any).dtliThumb,
      originalScore: reviewFile.originalScore !== null ? String(reviewFile.originalScore) : null,
      originalRating: (reviewFile as any).originalRating
    };

    const scoringInput = buildScoringInput(reviewData);

    if (!scoringInput.text || scoringInput.text.length < 50) {
      return {
        success: false,
        error: 'Review text too short or missing'
      };
    }

    // Score with ensemble
    const ensembleResult = await this.scoreReview(scoringInput.text, scoringInput.context);

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

    // Build the scored file
    const scoredFile: ScoredReviewFile = {
      ...reviewFile,
      assignedScore: ensembleResult.score,
      llmScore: {
        score: ensembleResult.score,
        confidence: ensembleResult.confidence,
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
        previousScore: reviewFile.assignedScore,
        previousVersion: (reviewFile as any).llmMetadata?.promptVersion
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
        modelAgreement: ensembleResult.agreement
      }
    };

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
      parts.push(`GPT-4o: ${modelResults.openai.reasoning}`);
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
    claude: { input: number; output: number };
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
      claude: { input: claudeUsage.input, output: claudeUsage.output },
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
