/**
 * Kimi K2.5 Scorer Module
 *
 * Uses Kimi K2.5 via OpenRouter for review scoring.
 * Added as 4th model to improve ensemble accuracy, especially on negative reviews.
 */

import { SimplifiedLLMResult, Bucket } from './types';
import { SYSTEM_PROMPT_V5, buildPromptV5, BUCKET_RANGES, clampScoreToBucket } from './config';

// ========================================
// TYPES
// ========================================

interface KimiScoringOptions {
  model: string;
  maxRetries: number;
  verbose: boolean;
  temperature: number;
}

interface KimiScoringOutcome {
  success: boolean;
  result?: SimplifiedLLMResult;
  rejected?: boolean;
  rejection?: string;
  rejectionReasoning?: string;
  error?: string;
  inputTokens: number;
  outputTokens: number;
}

// ========================================
// KIMI SCORER CLASS
// ========================================

export class KimiScorer {
  private apiKey: string;
  private options: KimiScoringOptions;
  private totalInputTokens: number = 0;
  private totalOutputTokens: number = 0;

  constructor(apiKey: string, options: Partial<KimiScoringOptions> = {}) {
    this.apiKey = apiKey;
    this.options = {
      model: options.model || 'moonshotai/kimi-k2.5',
      maxRetries: options.maxRetries ?? 3,
      verbose: options.verbose ?? false,
      temperature: options.temperature ?? 0.3
    };
  }

  /**
   * Score a single review text
   */
  async scoreReview(reviewText: string, context: string = ''): Promise<KimiScoringOutcome> {
    const prompt = buildPromptV5(reviewText, context);

    let lastError: string = '';
    let inputTokens = 0;
    let outputTokens = 0;

    for (let attempt = 1; attempt <= this.options.maxRetries; attempt++) {
      try {
        if (this.options.verbose && attempt > 1) {
          console.log(`  Kimi retry attempt ${attempt}/${this.options.maxRetries}...`);
        }

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
            'HTTP-Referer': 'https://broadwayscorecard.com',
            'X-Title': 'Broadway Scorecard'
          },
          body: JSON.stringify({
            model: this.options.model,
            messages: [
              { role: 'system', content: SYSTEM_PROMPT_V5 },
              { role: 'user', content: prompt }
            ],
            max_tokens: 500,
            temperature: this.options.temperature
          })
        });

        if (!response.ok) {
          const errorBody = await response.text();
          if (response.status === 429) {
            const waitTime = Math.pow(2, attempt) * 1000;
            if (this.options.verbose) {
              console.log(`  Kimi rate limited. Waiting ${waitTime / 1000}s...`);
            }
            await new Promise(r => setTimeout(r, waitTime));
            continue;
          }
          throw new Error(`OpenRouter API error: ${response.status} - ${errorBody}`);
        }

        const data = await response.json() as {
          usage?: { prompt_tokens?: number; completion_tokens?: number };
          choices?: Array<{ message?: { content?: string } }>;
        };

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

        // Check for scoreability rejection (v5.2+)
        const rejection = this.parseRejection(content);
        if (rejection) {
          return {
            success: true,
            rejected: true,
            rejection: rejection.rejection,
            rejectionReasoning: rejection.reasoning,
            inputTokens,
            outputTokens
          };
        }

        const result = this.parseV5Response(content);
        if (!result) {
          lastError = 'Failed to parse V5 response JSON';
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

  /**
   * Parse V5 simplified response format
   */
  private parseV5Response(responseText: string): SimplifiedLLMResult | null {
    let cleaned = responseText.trim();

    // Remove markdown code fences if present
    if (cleaned.startsWith('```json')) {
      cleaned = cleaned.slice(7);
    } else if (cleaned.startsWith('```')) {
      cleaned = cleaned.slice(3);
    }
    if (cleaned.endsWith('```')) {
      cleaned = cleaned.slice(0, -3);
    }
    cleaned = cleaned.trim();

    try {
      const parsed = JSON.parse(cleaned);
      return this.validateAndNormalizeV5(parsed);
    } catch (e) {
      return this.extractFromMalformedV5(responseText);
    }
  }

  /**
   * Validate and normalize V5 parsed response
   */
  private validateAndNormalizeV5(parsed: any): SimplifiedLLMResult | null {
    const validBuckets: Bucket[] = ['Rave', 'Positive', 'Mixed', 'Negative', 'Pan'];
    let bucket: Bucket = parsed.bucket;

    if (!validBuckets.includes(bucket)) {
      const bucketMap: Record<string, Bucket> = {
        'RAVE': 'Rave', 'rave': 'Rave',
        'POSITIVE': 'Positive', 'positive': 'Positive',
        'MIXED': 'Mixed', 'mixed': 'Mixed',
        'NEGATIVE': 'Negative', 'negative': 'Negative',
        'PAN': 'Pan', 'pan': 'Pan'
      };
      bucket = bucketMap[parsed.bucket] || 'Mixed';
    }

    let score = typeof parsed.score === 'number' ? parsed.score : parseInt(parsed.score);
    if (isNaN(score)) {
      const range = BUCKET_RANGES[bucket];
      score = Math.floor((range.min + range.max) / 2);
    }

    score = clampScoreToBucket(score, bucket);

    const validConfidences = ['high', 'medium', 'low'];
    const confidence = validConfidences.includes(parsed.confidence)
      ? parsed.confidence as 'high' | 'medium' | 'low'
      : 'medium';

    return {
      bucket,
      score: Math.round(score),
      confidence,
      verdict: String(parsed.verdict || ''),
      keyQuote: String(parsed.keyQuote || ''),
      reasoning: String(parsed.reasoning || '')
    };
  }

  /**
   * Try to extract from malformed V5 response
   */
  private extractFromMalformedV5(response: string): SimplifiedLLMResult | null {
    const bucketMatch = response.match(/"bucket"\s*:\s*"(Rave|Positive|Mixed|Negative|Pan)"/i);
    const scoreMatch = response.match(/"score"\s*:\s*(\d+)/);

    if (bucketMatch && scoreMatch) {
      const bucket = bucketMatch[1] as Bucket;
      let score = parseInt(scoreMatch[1]);
      score = clampScoreToBucket(score, bucket);

      return {
        bucket,
        score: Math.round(score),
        confidence: 'low',
        verdict: '',
        keyQuote: '',
        reasoning: 'Extracted from malformed response'
      };
    }

    return null;
  }

  /**
   * Check if the response is a scoreability rejection (v5.2+)
   */
  private parseRejection(responseText: string): { rejection: string; reasoning: string } | null {
    let cleaned = responseText.trim();
    if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
    else if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
    if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
    cleaned = cleaned.trim();

    try {
      const parsed = JSON.parse(cleaned);
      if (parsed.scoreable === false) {
        return {
          rejection: String(parsed.rejection || 'unknown'),
          reasoning: String(parsed.reasoning || '')
        };
      }
    } catch {
      if (responseText.includes('"scoreable"') && responseText.includes('false')) {
        const rejMatch = responseText.match(/"rejection"\s*:\s*"([^"]+)"/);
        const resMatch = responseText.match(/"reasoning"\s*:\s*"([^"]+)"/);
        if (rejMatch) {
          return {
            rejection: rejMatch[1],
            reasoning: resMatch ? resMatch[1] : ''
          };
        }
      }
    }
    return null;
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
