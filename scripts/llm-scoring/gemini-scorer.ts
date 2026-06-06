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
import { SYSTEM_PROMPT_V5, buildPromptV5, BUCKET_RANGES, GEMINI_CALIBRATION_OFFSET } from './config';

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
  rejected?: boolean;
  rejection?: string;
  rejectionReasoning?: string;
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
      // 2026-04-28: switched default from 'gemini-2.5-flash' to 'gemini-2.5-flash'.
      // 2.0-flash hit free-tier 1500 RPD repeatedly during bulk rescores, causing
      // every Gemini call to fail through 5 retries (~60s/call) and silently
      // demoting the ensemble to two-model-fallback. 2.5-flash uses a separate
      // quota pool. The thinkingConfig:{thinkingBudget:0} below disables 2.5's
      // hidden reasoning tokens that would otherwise truncate V5 JSON output.
      model: options.model || 'gemini-2.5-flash',
      maxRetries: options.maxRetries ?? 5,
      verbose: options.verbose ?? false,
      temperature: options.temperature ?? 0.3
    };
  }

  /**
   * Score a single review text.
   * Optional `systemPromptOverride` lets the A/B harness swap in a candidate
   * prompt while leaving the live SYSTEM_PROMPT_V5 untouched.
   */
  async scoreReview(reviewText: string, context: string = '', systemPromptOverride?: string): Promise<GeminiScoringOutcome> {
    const model = this.client.getGenerativeModel({
      model: this.options.model,
      generationConfig: {
        temperature: this.options.temperature,
        topP: 0.8,
        maxOutputTokens: 500,
        // Gemini 2.5 enables "thinking mode" by default — hidden reasoning
        // tokens are deducted from maxOutputTokens before any output text is
        // generated. With maxOutputTokens=500 and ~400 thinking tokens, the
        // V5 JSON gets cut off mid-string and parses as malformed. Setting
        // thinkingBudget=0 disables thinking entirely. Ignored by 2.0-flash
        // and earlier models. (Caught 2026-04-28 when migrating A/B harness
        // to 2.5-flash for separate quota pool.)
        thinkingConfig: { thinkingBudget: 0 },
      } as any,
    });

    const prompt = buildPromptV5(reviewText, context);
    const systemPrompt = systemPromptOverride || SYSTEM_PROMPT_V5;
    const fullPrompt = systemPrompt + '\n\n' + prompt;

    let lastError: string = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let parseFailureCount = 0;

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

        // Check for scoreability rejection (v5.2+)
        const rejection = this.parseRejection(text);
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

        const parsed = this.parseResponse(text);
        if (!parsed) {
          lastError = 'Failed to parse Gemini response';
          parseFailureCount++;
          if (this.options.verbose) {
            console.log(`  Parse error (${parseFailureCount}x). Response: ${text.substring(0, 200)}...`);
          }
          // Same input produces same unparseable output — don't waste more API calls
          if (parseFailureCount >= 2) break;
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

        // Retry all errors with backoff (rate limits, spending limits, server errors, network errors)
        const isRateLimit = error.status === 429 || error.message?.includes('429');
        const isServerError = error.status >= 500;
        const waitTime = isRateLimit
          ? Math.pow(2, attempt) * 1000
          : isServerError
            ? Math.pow(2, attempt) * 500
            : Math.pow(2, attempt) * 15000;
        if (this.options.verbose) {
          console.log(`  Gemini error (${error.status || 'network'}): ${lastError.substring(0, 100)}. Retrying in ${waitTime / 1000}s...`);
        }
        await new Promise(r => setTimeout(r, waitTime));
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
    score = Math.max(0, Math.min(100, score));

    // Validate confidence
    const validConfidences = ['high', 'medium', 'low'];
    const confidence = validConfidences.includes(parsed.confidence)
      ? parsed.confidence as 'high' | 'medium' | 'low'
      : 'medium';

    // Validate publishDate if provided
    let publishDate: string | null = null;
    if (parsed.publishDate && typeof parsed.publishDate === 'string') {
      const dm = parsed.publishDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (dm) {
        const [, ys, ms, ds] = dm;
        const y = parseInt(ys), m = parseInt(ms), d = parseInt(ds);
        const dt = new Date(y, m - 1, d);
        if (y >= 1970 && y <= 2027 && dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d) {
          publishDate = parsed.publishDate;
        }
      }
    }

    return {
      bucket,
      score: Math.round(score),
      confidence,
      verdict: String(parsed.verdict || ''),
      keyQuote: String(parsed.keyQuote || ''),
      reasoning: String(parsed.reasoning || ''),
      publishDate,
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
      score = Math.max(0, Math.min(100, score));

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
