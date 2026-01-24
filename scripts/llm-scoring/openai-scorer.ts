/**
 * OpenAI Scorer Module
 *
 * Uses GPT-4o-mini for review scoring to provide triangulation
 * with Claude Sonnet for more robust consensus scores.
 */

import { LLMScoringResult, ReviewTextFile, ScoredReviewFile } from './types';
import { SYSTEM_PROMPT, buildPrompt, scoreToBucket, scoreToThumb, PROMPT_VERSION } from './config';

// ========================================
// TYPES
// ========================================

interface OpenAIScoringOptions {
  model: 'gpt-4o-mini' | 'gpt-4o';
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

function parseResponse(responseText: string): LLMScoringResult | null {
  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    const scoreMatch = responseText.match(/"?score"?\s*:\s*(\d+)/i);
    if (scoreMatch) {
      return createDefaultResult(parseInt(scoreMatch[1]));
    }
    return null;
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);

    if (typeof parsed.score !== 'number' || parsed.score < 0 || parsed.score > 100) {
      if (typeof parsed.score === 'string') {
        parsed.score = parseInt(parsed.score);
        if (isNaN(parsed.score)) return null;
      } else {
        return null;
      }
    }

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

    result.bucket = scoreToBucket(result.score);
    result.thumb = scoreToThumb(result.score);

    return result;
  } catch (e) {
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

export class OpenAIReviewScorer {
  private apiKey: string;
  private options: OpenAIScoringOptions;
  private totalInputTokens: number = 0;
  private totalOutputTokens: number = 0;

  constructor(apiKey: string, options: Partial<OpenAIScoringOptions> = {}) {
    this.apiKey = apiKey;
    this.options = {
      model: options.model || 'gpt-4o-mini',
      maxRetries: options.maxRetries ?? 3,
      verbose: options.verbose ?? false
    };
  }

  async scoreReview(reviewText: string): Promise<ScoringOutcome> {
    const prompt = buildPrompt(reviewText);

    let lastError: string = '';
    let inputTokens = 0;
    let outputTokens = 0;

    for (let attempt = 1; attempt <= this.options.maxRetries; attempt++) {
      try {
        if (this.options.verbose && attempt > 1) {
          console.log(`  OpenAI retry attempt ${attempt}/${this.options.maxRetries}...`);
        }

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`
          },
          body: JSON.stringify({
            model: this.options.model,
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: prompt }
            ],
            max_tokens: 1000,
            temperature: 0.3
          })
        });

        if (!response.ok) {
          const errorBody = await response.text();
          if (response.status === 429) {
            const waitTime = Math.pow(2, attempt) * 1000;
            if (this.options.verbose) {
              console.log(`  Rate limited. Waiting ${waitTime / 1000}s...`);
            }
            await new Promise(r => setTimeout(r, waitTime));
            continue;
          }
          throw new Error(`OpenAI API error: ${response.status} - ${errorBody}`);
        }

        const data = await response.json();

        // Track tokens
        inputTokens = data.usage?.prompt_tokens || 0;
        outputTokens = data.usage?.completion_tokens || 0;
        this.totalInputTokens += inputTokens;
        this.totalOutputTokens += outputTokens;

        const content = data.choices?.[0]?.message?.content;
        if (!content) {
          lastError = 'No content in response';
          continue;
        }

        const result = parseResponse(content);
        if (!result) {
          lastError = 'Failed to parse response JSON';
          if (this.options.verbose) {
            console.log(`  Parse error. Response: ${content.substring(0, 200)}...`);
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

        if (error.message?.includes('429')) {
          const waitTime = Math.pow(2, attempt) * 1000;
          await new Promise(r => setTimeout(r, waitTime));
        } else if (error.message?.includes('5')) {
          const waitTime = Math.pow(2, attempt) * 500;
          await new Promise(r => setTimeout(r, waitTime));
        } else {
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

  async scoreReviewFile(reviewFile: ReviewTextFile): Promise<{
    success: boolean;
    scoredFile?: ScoredReviewFile;
    error?: string;
  }> {
    if (!reviewFile.fullText || reviewFile.fullText.length < 50) {
      return {
        success: false,
        error: 'Review text too short or missing'
      };
    }

    const outcome = await this.scoreReview(reviewFile.fullText);

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
        outputTokens: outcome.outputTokens
      }
    };

    return {
      success: true,
      scoredFile
    };
  }

  getTokenUsage(): { input: number; output: number; total: number } {
    return {
      input: this.totalInputTokens,
      output: this.totalOutputTokens,
      total: this.totalInputTokens + this.totalOutputTokens
    };
  }

  resetTokenUsage(): void {
    this.totalInputTokens = 0;
    this.totalOutputTokens = 0;
  }
}
