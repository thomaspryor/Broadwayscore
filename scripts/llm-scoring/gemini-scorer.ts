/**
 * Gemini Scorer Module
 *
 * Handles API calls to Google's Gemini for review scoring with:
 * - Response normalization (handles markdown fences, case variations)
 * - Retry logic with exponential backoff
 * - Bucket/score validation and clamping
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { SimplifiedLLMResult, Bucket } from './types';
import { SYSTEM_PROMPT_V5, buildPromptV5, BUCKET_RANGES, clampScoreToBucket, GEMINI_CALIBRATION_OFFSET } from './config';

// ========================================
// TYPES
// ========================================

interface GeminiScoringOptions {
  model: string;
  maxRetries: number;
  verbose: boolean;
  temperature: number;
}

interface GeminiScoringOutcome {
  success: boolean;
  result?: SimplifiedLLMResult;
  error?: string;
  inputTokens: number;
  outputTokens: number;
}

// ========================================
// GEMINI SCORER CLASS
// ========================================

export class GeminiScorer {
  private client: GoogleGenerativeAI;
  private options: GeminiScoringOptions;
  private totalInputTokens: number = 0;
  private totalOutputTokens: number = 0;

  constructor(apiKey: string, options: Partial<GeminiScoringOptions> = {}) {
    this.client = new GoogleGenerativeAI(apiKey);
    this.options = {
      model: options.model || 'gemini-2.0-flash',
      maxRetries: options.maxRetries ?? 3,
      verbose: options.verbose ?? false,
      temperature: options.temperature ?? 0.3
    };
  }

  /**
   * Score a single review text
   */
  async scoreReview(reviewText: string, context: string = ''): Promise<GeminiScoringOutcome> {
    const model = this.client.getGenerativeModel({
      model: this.options.model,
      generationConfig: {
        temperature: this.options.temperature,
        topP: 0.8,
        maxOutputTokens: 500
      }
    });

    const prompt = buildPromptV5(reviewText, context);
    const fullPrompt = SYSTEM_PROMPT_V5 + '\n\n' + prompt;

    let lastError: string = '';
    let inputTokens = 0;
    let outputTokens = 0;

    for (let attempt = 1; attempt <= this.options.maxRetries; attempt++) {
      try {
        if (this.options.verbose && attempt > 1) {
          console.log(`  Gemini retry attempt ${attempt}/${this.options.maxRetries}...`);
        }

        const result = await model.generateContent(fullPrompt);
        const response = result.response;

        // Track tokens (Gemini may not provide exact counts)
        const usage = response.usageMetadata;
        inputTokens = usage?.promptTokenCount || 0;
        outputTokens = usage?.candidatesTokenCount || 0;
        this.totalInputTokens += inputTokens;
        this.totalOutputTokens += outputTokens;

        const text = response.text();
        if (!text) {
          lastError = 'Empty response from Gemini';
          continue;
        }

        const parsed = this.parseResponse(text);
        if (!parsed) {
          lastError = 'Failed to parse Gemini response';
          if (this.options.verbose) {
            console.log(`  Parse error. Response: ${text.substring(0, 200)}...`);
          }
          continue;
        }

        return {
          success: true,
          result: parsed,
          inputTokens,
          outputTokens
        };
      } catch (error: any) {
        lastError = error.message || String(error);

        // Handle rate limiting
        if (error.status === 429 || error.message?.includes('429')) {
          const waitTime = Math.pow(2, attempt) * 1000;
          if (this.options.verbose) {
            console.log(`  Gemini rate limited. Waiting ${waitTime / 1000}s...`);
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
   * Parse Gemini response into structured result
   */
  private parseResponse(response: string): SimplifiedLLMResult | null {
    let cleaned = response.trim();

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
      return this.validateAndNormalize(parsed);
    } catch (e) {
      // Try to extract from malformed response
      return this.extractFromMalformed(response);
    }
  }

  /**
   * Validate and normalize parsed response
   */
  private validateAndNormalize(parsed: any): SimplifiedLLMResult | null {
    // Validate bucket
    const validBuckets: Bucket[] = ['Rave', 'Positive', 'Mixed', 'Negative', 'Pan'];
    let bucket: Bucket = parsed.bucket;

    if (!validBuckets.includes(bucket)) {
      // Try to map common variations
      const bucketMap: Record<string, Bucket> = {
        'RAVE': 'Rave', 'rave': 'Rave',
        'POSITIVE': 'Positive', 'positive': 'Positive',
        'MIXED': 'Mixed', 'mixed': 'Mixed',
        'NEGATIVE': 'Negative', 'negative': 'Negative',
        'PAN': 'Pan', 'pan': 'Pan'
      };
      bucket = bucketMap[parsed.bucket] || 'Mixed';
    }

    // Validate and clamp score
    let score = typeof parsed.score === 'number' ? parsed.score : parseInt(parsed.score);
    if (isNaN(score)) {
      // Default to middle of bucket range
      const range = BUCKET_RANGES[bucket];
      score = Math.floor((range.min + range.max) / 2);
    }

    // Apply calibration offset
    score = score + GEMINI_CALIBRATION_OFFSET;

    // Clamp to bucket range
    score = clampScoreToBucket(score, bucket);

    // Validate confidence
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
   * Try to extract score/bucket from malformed response
   */
  private extractFromMalformed(response: string): SimplifiedLLMResult | null {
    // Try to find bucket
    const bucketMatch = response.match(/"bucket"\s*:\s*"(Rave|Positive|Mixed|Negative|Pan)"/i);
    const scoreMatch = response.match(/"score"\s*:\s*(\d+)/);

    if (bucketMatch && scoreMatch) {
      const bucket = bucketMatch[1] as Bucket;
      let score = parseInt(scoreMatch[1]) + GEMINI_CALIBRATION_OFFSET;
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
