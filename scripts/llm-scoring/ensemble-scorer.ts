/**
 * Ensemble Scorer Module
 *
 * Combines Claude Sonnet + GPT-4o-mini for robust scoring through triangulation.
 * Validates scores against DTLI/BWW thumbs data for quality assurance.
 */

import { ReviewScorer } from './scorer';
import { OpenAIReviewScorer } from './openai-scorer';
import { LLMScoringResult, ReviewTextFile, ScoredReviewFile, ExtractedPhrase, ComponentScores } from './types';
import { scoreToBucket, scoreToThumb, PROMPT_VERSION } from './config';

// ========================================
// TYPES
// ========================================

export interface EnsembleResult {
  // Final combined score
  score: number;
  confidence: 'high' | 'medium' | 'low';
  bucket: 'Rave' | 'Positive' | 'Mixed' | 'Negative' | 'Pan';
  thumb: 'Up' | 'Flat' | 'Down';

  // Individual model scores
  claudeScore: number | null;
  openaiScore: number | null;
  scoreDelta: number;

  // Validation
  thumbsMatch: boolean | null;  // null if no thumbs data available
  expectedThumb: 'Up' | 'Flat' | 'Down' | null;

  // Flags
  needsReview: boolean;
  needsReviewReasons: string[];

  // Full results from each model
  claudeResult: LLMScoringResult | null;
  openaiResult: LLMScoringResult | null;

  // Combined reasoning
  reasoning: string;
  keyPhrases: ExtractedPhrase[];
  components: ComponentScores;
}

export interface EnsembleScoringOptions {
  claudeModel: 'claude-sonnet-4-20250514' | 'claude-3-5-haiku-20241022';
  openaiModel: 'gpt-4o-mini' | 'gpt-4o';
  maxDelta: number;  // Maximum acceptable difference between models
  verbose: boolean;
}

// ========================================
// ENSEMBLE SCORER
// ========================================

export class EnsembleReviewScorer {
  private claudeScorer: ReviewScorer;
  private openaiScorer: OpenAIReviewScorer;
  private options: EnsembleScoringOptions;

  constructor(
    claudeApiKey: string,
    openaiApiKey: string,
    options: Partial<EnsembleScoringOptions> = {}
  ) {
    this.options = {
      claudeModel: options.claudeModel || 'claude-sonnet-4-20250514',
      openaiModel: options.openaiModel || 'gpt-4o-mini',
      maxDelta: options.maxDelta ?? 15,
      verbose: options.verbose ?? false
    };

    this.claudeScorer = new ReviewScorer(claudeApiKey, {
      model: this.options.claudeModel,
      verbose: this.options.verbose
    });

    this.openaiScorer = new OpenAIReviewScorer(openaiApiKey, {
      model: this.options.openaiModel,
      verbose: this.options.verbose
    });
  }

  /**
   * Score a review using both models and combine results
   */
  async scoreReview(
    reviewText: string,
    thumbsData?: { dtli?: 'Up' | 'Flat' | 'Down'; bww?: 'Up' | 'Flat' | 'Down' }
  ): Promise<EnsembleResult> {
    // Score with both models in parallel
    const [claudeOutcome, openaiOutcome] = await Promise.all([
      this.claudeScorer.scoreReview(reviewText),
      this.openaiScorer.scoreReview(reviewText)
    ]);

    const claudeScore = claudeOutcome.success && claudeOutcome.result ? claudeOutcome.result.score : null;
    const openaiScore = openaiOutcome.success && openaiOutcome.result ? openaiOutcome.result.score : null;

    // Calculate delta
    const scoreDelta = claudeScore !== null && openaiScore !== null
      ? Math.abs(claudeScore - openaiScore)
      : 0;

    // Determine final score
    let finalScore: number;
    let confidence: 'high' | 'medium' | 'low';

    if (claudeScore !== null && openaiScore !== null) {
      // Both models succeeded - use average
      finalScore = Math.round((claudeScore + openaiScore) / 2);

      if (scoreDelta <= 5) {
        confidence = 'high';  // Models agree closely
      } else if (scoreDelta <= this.options.maxDelta) {
        confidence = 'medium';  // Reasonable agreement
      } else {
        confidence = 'low';  // Significant disagreement
      }
    } else if (claudeScore !== null) {
      // Only Claude succeeded
      finalScore = claudeScore;
      confidence = 'medium';
    } else if (openaiScore !== null) {
      // Only OpenAI succeeded
      finalScore = openaiScore;
      confidence = 'medium';
    } else {
      // Both failed
      finalScore = 50;  // Neutral fallback
      confidence = 'low';
    }

    // Validate against thumbs data
    const expectedThumb = this.getExpectedThumb(thumbsData);
    const actualThumb = scoreToThumb(finalScore);
    const thumbsMatch = expectedThumb ? actualThumb === expectedThumb : null;

    // Determine if review is needed
    const needsReviewReasons: string[] = [];

    if (scoreDelta > this.options.maxDelta) {
      needsReviewReasons.push(`Models disagree by ${scoreDelta} points (Claude: ${claudeScore}, OpenAI: ${openaiScore})`);
    }

    if (thumbsMatch === false) {
      needsReviewReasons.push(`Score (${finalScore} → ${actualThumb}) conflicts with aggregator thumbs (${expectedThumb})`);
    }

    if (claudeScore === null && openaiScore === null) {
      needsReviewReasons.push('Both models failed to score');
    }

    // Combine key phrases and components from both models
    const claudeResult = claudeOutcome.result || null;
    const openaiResult = openaiOutcome.result || null;

    const keyPhrases = this.combineKeyPhrases(claudeResult, openaiResult);
    const components = this.combineComponents(claudeResult, openaiResult);
    const reasoning = this.combineReasoning(claudeResult, openaiResult, scoreDelta);

    return {
      score: finalScore,
      confidence,
      bucket: scoreToBucket(finalScore),
      thumb: actualThumb,
      claudeScore,
      openaiScore,
      scoreDelta,
      thumbsMatch,
      expectedThumb,
      needsReview: needsReviewReasons.length > 0,
      needsReviewReasons,
      claudeResult,
      openaiResult,
      reasoning,
      keyPhrases,
      components
    };
  }

  /**
   * Score a review file and return updated content
   */
  async scoreReviewFile(reviewFile: ReviewTextFile): Promise<{
    success: boolean;
    scoredFile?: ScoredReviewFile;
    ensembleResult?: EnsembleResult;
    error?: string;
  }> {
    if (!reviewFile.fullText || reviewFile.fullText.length < 50) {
      return {
        success: false,
        error: 'Review text too short or missing'
      };
    }

    // Get thumbs data if available
    const thumbsData: { dtli?: 'Up' | 'Flat' | 'Down'; bww?: 'Up' | 'Flat' | 'Down' } = {};

    // Map bwwThumb to our format
    if (reviewFile.bwwThumb) {
      const bwwMap: Record<string, 'Up' | 'Flat' | 'Down'> = {
        'Up': 'Up',
        'Rave': 'Up',
        'Positive': 'Up',
        'Flat': 'Flat',
        'Mixed': 'Flat',
        'Meh': 'Flat',
        'Down': 'Down',
        'Pan': 'Down',
        'Negative': 'Down'
      };
      thumbsData.bww = bwwMap[reviewFile.bwwThumb] || undefined;
    }

    const ensembleResult = await this.scoreReview(reviewFile.fullText, thumbsData);

    // Build the LLM score result for storage
    const llmScore: LLMScoringResult = {
      score: ensembleResult.score,
      confidence: ensembleResult.confidence,
      range: {
        low: Math.max(0, ensembleResult.score - (ensembleResult.scoreDelta / 2 + 5)),
        high: Math.min(100, ensembleResult.score + (ensembleResult.scoreDelta / 2 + 5))
      },
      bucket: ensembleResult.bucket,
      thumb: ensembleResult.thumb,
      components: ensembleResult.components,
      keyPhrases: ensembleResult.keyPhrases,
      reasoning: ensembleResult.reasoning,
      flags: {
        hasExplicitRecommendation: ensembleResult.claudeResult?.flags?.hasExplicitRecommendation ||
                                    ensembleResult.openaiResult?.flags?.hasExplicitRecommendation || false,
        focusedOnPerformances: ensembleResult.claudeResult?.flags?.focusedOnPerformances ||
                                ensembleResult.openaiResult?.flags?.focusedOnPerformances || false,
        comparesToPrevious: ensembleResult.claudeResult?.flags?.comparesToPrevious ||
                             ensembleResult.openaiResult?.flags?.comparesToPrevious || false,
        mixedSignals: ensembleResult.needsReview
      }
    };

    const scoredFile: ScoredReviewFile = {
      ...reviewFile,
      assignedScore: ensembleResult.score,
      llmScore,
      llmMetadata: {
        model: `ensemble:${this.options.claudeModel}+${this.options.openaiModel}`,
        scoredAt: new Date().toISOString(),
        promptVersion: PROMPT_VERSION,
        inputTokens: 0,  // Combined below
        outputTokens: 0
      },
      ensembleData: {
        claudeScore: ensembleResult.claudeScore,
        openaiScore: ensembleResult.openaiScore,
        scoreDelta: ensembleResult.scoreDelta,
        thumbsMatch: ensembleResult.thumbsMatch,
        expectedThumb: ensembleResult.expectedThumb,
        needsReview: ensembleResult.needsReview,
        needsReviewReasons: ensembleResult.needsReviewReasons
      }
    };

    return {
      success: true,
      scoredFile,
      ensembleResult
    };
  }

  /**
   * Get expected thumb from DTLI/BWW data
   * Prefers DTLI over BWW if both available
   */
  private getExpectedThumb(
    thumbsData?: { dtli?: 'Up' | 'Flat' | 'Down'; bww?: 'Up' | 'Flat' | 'Down' }
  ): 'Up' | 'Flat' | 'Down' | null {
    if (!thumbsData) return null;

    // DTLI is generally more reliable
    if (thumbsData.dtli) return thumbsData.dtli;
    if (thumbsData.bww) return thumbsData.bww;

    return null;
  }

  /**
   * Combine key phrases from both models
   */
  private combineKeyPhrases(
    claudeResult: LLMScoringResult | null,
    openaiResult: LLMScoringResult | null
  ): ExtractedPhrase[] {
    const phrases: ExtractedPhrase[] = [];
    const seen = new Set<string>();

    // Add Claude phrases first
    if (claudeResult?.keyPhrases) {
      for (const phrase of claudeResult.keyPhrases) {
        const normalized = phrase.quote.toLowerCase().trim();
        if (!seen.has(normalized)) {
          seen.add(normalized);
          phrases.push(phrase);
        }
      }
    }

    // Add OpenAI phrases that aren't duplicates
    if (openaiResult?.keyPhrases) {
      for (const phrase of openaiResult.keyPhrases) {
        const normalized = phrase.quote.toLowerCase().trim();
        if (!seen.has(normalized) && phrases.length < 5) {
          seen.add(normalized);
          phrases.push(phrase);
        }
      }
    }

    return phrases.slice(0, 3);
  }

  /**
   * Combine component scores from both models (average if both present)
   */
  private combineComponents(
    claudeResult: LLMScoringResult | null,
    openaiResult: LLMScoringResult | null
  ): ComponentScores {
    const components: ComponentScores = {
      book: null,
      music: null,
      performances: null,
      direction: null
    };

    const keys: (keyof ComponentScores)[] = ['book', 'music', 'performances', 'direction'];

    for (const key of keys) {
      const claudeVal = claudeResult?.components?.[key] ?? null;
      const openaiVal = openaiResult?.components?.[key] ?? null;

      if (claudeVal !== null && openaiVal !== null) {
        components[key] = Math.round((claudeVal + openaiVal) / 2);
      } else if (claudeVal !== null) {
        components[key] = claudeVal;
      } else if (openaiVal !== null) {
        components[key] = openaiVal;
      }
    }

    return components;
  }

  /**
   * Combine reasoning from both models
   */
  private combineReasoning(
    claudeResult: LLMScoringResult | null,
    openaiResult: LLMScoringResult | null,
    scoreDelta: number
  ): string {
    const parts: string[] = [];

    if (claudeResult?.reasoning) {
      parts.push(`Claude: ${claudeResult.reasoning}`);
    }

    if (openaiResult?.reasoning && openaiResult.reasoning !== claudeResult?.reasoning) {
      parts.push(`GPT-4o-mini: ${openaiResult.reasoning}`);
    }

    if (scoreDelta > 10 && claudeResult && openaiResult) {
      parts.push(`Note: Models differed by ${scoreDelta} points.`);
    }

    return parts.join(' | ') || 'No reasoning available';
  }

  /**
   * Get combined token usage from both models
   */
  getTokenUsage(): {
    claude: { input: number; output: number };
    openai: { input: number; output: number };
    total: number;
  } {
    const claudeUsage = this.claudeScorer.getTokenUsage();
    const openaiUsage = this.openaiScorer.getTokenUsage();

    return {
      claude: { input: claudeUsage.input, output: claudeUsage.output },
      openai: { input: openaiUsage.input, output: openaiUsage.output },
      total: claudeUsage.total + openaiUsage.total
    };
  }

  resetTokenUsage(): void {
    this.claudeScorer.resetTokenUsage();
    this.openaiScorer.resetTokenUsage();
  }
}
