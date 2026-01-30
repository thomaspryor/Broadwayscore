/**
 * LLM Scorer Module
 *
 * Handles API calls to Claude for review scoring with:
 * - Retry logic with exponential backoff
 * - Structured output parsing
 * - Token usage tracking
 */

import Anthropic from '@anthropic-ai/sdk';
import { LLMScoringResult, ScoredReviewFile, ReviewTextFile } from './types';
import { SYSTEM_PROMPT, buildPrompt, scoreToBucket, scoreToThumb, PROMPT_VERSION } from './config';

// Import text quality assessment module
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { getBestTextForScoring } = require('../lib/text-quality');

// ========================================
// TYPES
// ========================================

interface ScoringOptions {
  model: 'claude-sonnet-4-20250514' | 'claude-3-5-haiku-20241022';
  maxRetries: number;
  verbose: boolean;
}

interface ScoringOutcome {
  success: boolean;
  result?: LLMScoringResult;
  error?: string;
  inputTokens: number;
  outputTokens: number;
}

// ========================================
// DEFAULT RESULT
// ========================================

/**
 * Create a default LLM result for when parsing fails but we have a basic score
 */
function createDefaultResult(score: number, confidence: 'high' | 'medium' | 'low' = 'low'): LLMScoringResult {
  return {
    score,
    confidence,
    range: { low: Math.max(0, score - 10), high: Math.min(100, score + 10) },
    bucket: scoreToBucket(score),
    thumb: scoreToThumb(score),
    components: {
      book: null,
      music: null,
      performances: null,
      direction: null
    },
    keyPhrases: [],
    reasoning: 'Score extracted from partial response',
    flags: {
      hasExplicitRecommendation: false,
      focusedOnPerformances: false,
      comparesToPrevious: false,
      mixedSignals: false
    }
  };
}

// ========================================
// RESPONSE PARSING
// ========================================

/**
 * Parse the LLM response into a structured result
 * Handles partial responses and malformed JSON gracefully
 */
function parseResponse(responseText: string): LLMScoringResult | null {
  // Try to extract JSON from the response
  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    // Try to extract just a score
    const scoreMatch = responseText.match(/"?score"?\s*:\s*(\d+)/i);
    if (scoreMatch) {
      return createDefaultResult(parseInt(scoreMatch[1]));
    }
    return null;
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);

    // Validate required fields
    if (typeof parsed.score !== 'number' || parsed.score < 0 || parsed.score > 100) {
      if (typeof parsed.score === 'string') {
        parsed.score = parseInt(parsed.score);
        if (isNaN(parsed.score)) return null;
      } else {
        return null;
      }
    }

    // Normalize and fill defaults
    const result: LLMScoringResult = {
      score: Math.round(parsed.score),
      confidence: ['high', 'medium', 'low'].includes(parsed.confidence) ? parsed.confidence : 'medium',
      range: {
        low: parsed.range?.low ?? Math.max(0, parsed.score - 10),
        high: parsed.range?.high ?? Math.min(100, parsed.score + 10)
      },
      bucket: parsed.bucket || scoreToBucket(parsed.score),
      thumb: parsed.thumb || scoreToThumb(parsed.score),
      components: {
        book: parsed.components?.book ?? null,
        music: parsed.components?.music ?? null,
        performances: parsed.components?.performances ?? null,
        direction: parsed.components?.direction ?? null
      },
      keyPhrases: Array.isArray(parsed.keyPhrases)
        ? parsed.keyPhrases.slice(0, 3).map((kp: any) => ({
            quote: String(kp.quote || kp || ''),
            sentiment: ['positive', 'negative', 'neutral'].includes(kp.sentiment) ? kp.sentiment : 'neutral',
            strength: typeof kp.strength === 'number' ? Math.min(5, Math.max(1, kp.strength)) : 3
          }))
        : [],
      reasoning: String(parsed.reasoning || 'No reasoning provided'),
      flags: {
        hasExplicitRecommendation: Boolean(parsed.flags?.hasExplicitRecommendation),
        focusedOnPerformances: Boolean(parsed.flags?.focusedOnPerformances),
        comparesToPrevious: Boolean(parsed.flags?.comparesToPrevious),
        mixedSignals: Boolean(parsed.flags?.mixedSignals)
      }
    };

    // Ensure bucket and thumb are consistent with score
    result.bucket = scoreToBucket(result.score);
    result.thumb = scoreToThumb(result.score);

    return result;
  } catch (e) {
    // JSON parse failed, try to extract score
    const scoreMatch = responseText.match(/"?score"?\s*:\s*(\d+)/i);
    if (scoreMatch) {
      return createDefaultResult(parseInt(scoreMatch[1]));
    }
    return null;
  }
}

// ========================================
// MAIN SCORER CLASS
// ========================================

export class ReviewScorer {
  private client: Anthropic;
  private options: ScoringOptions;
  private totalInputTokens: number = 0;
  private totalOutputTokens: number = 0;

  constructor(apiKey: string, options: Partial<ScoringOptions> = {}) {
    this.client = new Anthropic({ apiKey });
    this.options = {
      model: options.model || 'claude-sonnet-4-20250514',
      maxRetries: options.maxRetries ?? 3,
      verbose: options.verbose ?? false
    };
  }

  /**
   * Score a single review text
   */
  async scoreReview(reviewText: string): Promise<ScoringOutcome> {
    const prompt = buildPrompt(reviewText);

    let lastError: string = '';
    let inputTokens = 0;
    let outputTokens = 0;

    for (let attempt = 1; attempt <= this.options.maxRetries; attempt++) {
      try {
        if (this.options.verbose && attempt > 1) {
          console.log(`  Retry attempt ${attempt}/${this.options.maxRetries}...`);
        }

        const response = await this.client.messages.create({
          model: this.options.model,
          max_tokens: 1000,
          system: SYSTEM_PROMPT,
          messages: [
            { role: 'user', content: prompt }
          ]
        });

        // Track tokens
        inputTokens = response.usage.input_tokens;
        outputTokens = response.usage.output_tokens;
        this.totalInputTokens += inputTokens;
        this.totalOutputTokens += outputTokens;

        // Extract text content
        const textContent = response.content.find(c => c.type === 'text');
        if (!textContent || textContent.type !== 'text') {
          lastError = 'No text content in response';
          continue;
        }

        const result = parseResponse(textContent.text);
        if (!result) {
          lastError = 'Failed to parse response JSON';
          if (this.options.verbose) {
            console.log(`  Parse error. Response: ${textContent.text.substring(0, 200)}...`);
          }
          continue;
        }

        return {
          success: true,
          result,
          inputTokens,
          outputTokens
        };
      } catch (error: any) {
        lastError = error.message || String(error);

        // Handle rate limiting with exponential backoff
        if (error.status === 429) {
          const waitTime = Math.pow(2, attempt) * 1000;
          if (this.options.verbose) {
            console.log(`  Rate limited. Waiting ${waitTime / 1000}s...`);
          }
          await new Promise(r => setTimeout(r, waitTime));
        } else if (error.status >= 500) {
          // Server error - retry with backoff
          const waitTime = Math.pow(2, attempt) * 500;
          await new Promise(r => setTimeout(r, waitTime));
        } else {
          // Other error - don't retry
          break;
        }
      }
    }

    return {
      success: false,
      error: lastError,
      inputTokens,
      outputTokens
    };
  }

  /**
   * Score a review file and return the updated file content
   * Uses intelligent text quality assessment to select the best text source
   */
  async scoreReviewFile(reviewFile: ReviewTextFile): Promise<{
    success: boolean;
    scoredFile?: ScoredReviewFile;
    error?: string;
  }> {
    // Use text quality assessment to get the best text for scoring
    const textSelection = getBestTextForScoring(reviewFile);

    if (!textSelection.text || textSelection.confidence === 'none') {
      return {
        success: false,
        error: textSelection.reasoning || 'No usable text found for scoring'
      };
    }

    if (this.options.verbose) {
      console.log(`  Text source: ${textSelection.type} (${textSelection.status})`);
      console.log(`  Confidence: ${textSelection.confidence}`);
      console.log(`  Reasoning: ${textSelection.reasoning}`);
    }

    const outcome = await this.scoreReview(textSelection.text);

    if (!outcome.success || !outcome.result) {
      return {
        success: false,
        error: outcome.error || 'Unknown error'
      };
    }

    const scoredFile: ScoredReviewFile = {
      ...reviewFile,
      assignedScore: outcome.result.score,
      llmScore: outcome.result,
      llmMetadata: {
        model: this.options.model,
        scoredAt: new Date().toISOString(),
        promptVersion: PROMPT_VERSION,
        inputTokens: outcome.inputTokens,
        outputTokens: outcome.outputTokens,
        textSource: {
          type: textSelection.type,
          status: textSelection.status,
          field: textSelection.field || textSelection.type,
          confidence: textSelection.confidence,
          reasoning: textSelection.reasoning
        }
      }
    };

    return {
      success: true,
      scoredFile
    };
  }

  /**
   * Get total token usage
   */
  getTokenUsage(): { input: number; output: number; total: number } {
    return {
      input: this.totalInputTokens,
      output: this.totalOutputTokens,
      total: this.totalInputTokens + this.totalOutputTokens
    };
  }

  /**
   * Reset token counter
   */
  resetTokenUsage(): void {
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
  }
}
