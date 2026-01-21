/**
 * Review Fetchers
 *
 * Utilities for fetching review data from various sources.
 * Designed for consistency and reliability.
 *
 * IMPORTANT: Web scraping is inherently fragile. These parsers
 * may need updates when source sites change their structure.
 * Always verify fetched data before merging.
 */

import { RawReview } from './types';
import { findOutletConfig } from './config';

// ===========================================
// HTTP FETCH UTILITIES
// ===========================================

/**
 * Fetch a URL with proper error handling and retries
 */
export async function fetchWithRetry(
  url: string,
  options: {
    maxRetries?: number;
    timeout?: number;
    headers?: Record<string, string>;
  } = {}
): Promise<string> {
  const { maxRetries = 3, timeout = 30000, headers = {} } = options;

  const defaultHeaders = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    ...headers,
  };

  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(url, {
        headers: defaultHeaders,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return await response.text();
    } catch (error) {
      lastError = error as Error;
      console.warn(`Fetch attempt ${attempt + 1} failed for ${url}: ${lastError.message}`);

      // Wait before retry with exponential backoff
      if (attempt < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
      }
    }
  }

  throw new Error(`Failed to fetch ${url} after ${maxRetries} attempts: ${lastError?.message}`);
}

// ===========================================
// HTML PARSING UTILITIES
// ===========================================

/**
 * Extract text content from HTML (basic implementation)
 * For more complex parsing, consider using a proper HTML parser library
 */
export function extractText(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract a value from HTML using a regex pattern
 */
export function extractByPattern(html: string, pattern: RegExp): string | null {
  const match = html.match(pattern);
  return match ? extractText(match[1] || match[0]) : null;
}

/**
 * Extract all matches from HTML using a regex pattern
 */
export function extractAllByPattern(html: string, pattern: RegExp): string[] {
  const matches: string[] = [];
  let match;
  const globalPattern = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');

  while ((match = globalPattern.exec(html)) !== null) {
    matches.push(extractText(match[1] || match[0]));
  }

  return matches;
}

// ===========================================
// BROADWAYWORLD PARSER
// ===========================================

/**
 * Parse reviews from BroadwayWorld show page
 * BWW aggregates critic reviews with ratings
 */
export function parseBroadwayWorldReviews(html: string, showTitle: string): RawReview[] {
  const reviews: RawReview[] = [];

  // BWW typically shows reviews in a list format
  // This is a simplified parser - may need adjustment based on current site structure

  // Look for review blocks (pattern may vary)
  const reviewPattern = /<div[^>]*class="[^"]*review[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
  const reviewBlocks = html.match(reviewPattern) || [];

  for (const block of reviewBlocks) {
    try {
      // Extract outlet name
      const outletMatch = block.match(/class="[^"]*outlet[^"]*"[^>]*>([^<]+)/i) ||
        block.match(/class="[^"]*source[^"]*"[^>]*>([^<]+)/i) ||
        block.match(/<strong>([^<]+)<\/strong>/i);
      const outletName = outletMatch ? extractText(outletMatch[1]) : null;

      if (!outletName) continue;

      // Extract critic name
      const criticMatch = block.match(/class="[^"]*critic[^"]*"[^>]*>([^<]+)/i) ||
        block.match(/by\s+([^<,]+)/i);
      const criticName = criticMatch ? extractText(criticMatch[1]) : undefined;

      // Extract rating
      const ratingMatch = block.match(/class="[^"]*rating[^"]*"[^>]*>([^<]+)/i) ||
        block.match(/(\d+(?:\.\d+)?)\s*(?:\/|out of)\s*(\d+)/i) ||
        block.match(/(positive|negative|mixed|rave|pan)/i);
      const originalRating = ratingMatch ? extractText(ratingMatch[1]) : undefined;

      // Extract URL
      const urlMatch = block.match(/href="([^"]+)"/i);
      const url = urlMatch ? urlMatch[1] : undefined;

      // Extract excerpt/quote
      const excerptMatch = block.match(/class="[^"]*quote[^"]*"[^>]*>([^<]+)/i) ||
        block.match(/class="[^"]*excerpt[^"]*"[^>]*>([^<]+)/i);
      const excerpt = excerptMatch ? extractText(excerptMatch[1]) : undefined;

      reviews.push({
        source: 'BroadwayWorld',
        outletName,
        criticName,
        url,
        originalRating,
        excerpt,
      });
    } catch (error) {
      console.warn(`Error parsing BWW review block: ${error}`);
    }
  }

  return reviews;
}

// ===========================================
// DIDTHEYLIKEIT PARSER
// ===========================================

/**
 * Parse reviews from DidTheyLikeIt
 * DTLI provides a clean aggregation with thumbs up/down/mixed
 */
export function parseDidTheyLikeItReviews(html: string, showTitle: string): RawReview[] {
  const reviews: RawReview[] = [];

  // DTLI uses a specific format for reviews
  // This parser looks for their review cards

  // Pattern for review entries (adjust based on actual site structure)
  const reviewPattern = /<article[^>]*class="[^"]*review[^"]*"[^>]*>([\s\S]*?)<\/article>/gi;
  const reviewBlocks = html.match(reviewPattern) || [];

  // Alternative: look for table rows if they use a table layout
  if (reviewBlocks.length === 0) {
    const tablePattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    const tableRows = html.match(tablePattern) || [];

    for (const row of tableRows) {
      // Skip header rows
      if (row.includes('<th')) continue;

      // Extract cells
      const cells = row.match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || [];
      if (cells.length < 2) continue;

      const firstCell = cells[0];
      if (!firstCell) continue;
      const outletName = extractText(firstCell);
      if (!outletName || outletName.toLowerCase() === 'outlet') continue;

      // Look for thumb indicator
      let originalRating: string | undefined;
      const thumbUp = row.includes('thumb-up') || row.includes('positive') || row.includes('👍');
      const thumbDown = row.includes('thumb-down') || row.includes('negative') || row.includes('👎');
      const thumbMixed = row.includes('mixed') || row.includes('neutral') || row.includes('👊');

      if (thumbUp) originalRating = 'Up';
      else if (thumbDown) originalRating = 'Down';
      else if (thumbMixed) originalRating = 'Mixed';

      // Extract URL
      const urlMatch = row.match(/href="([^"]+)"/i);
      const url = urlMatch ? urlMatch[1] : undefined;

      // Extract critic
      const criticMatch = row.match(/class="[^"]*critic[^"]*"[^>]*>([^<]+)/i);
      const criticName = criticMatch ? extractText(criticMatch[1]) : undefined;

      reviews.push({
        source: 'DidTheyLikeIt',
        outletName,
        criticName,
        url,
        originalRating,
        ratingType: 'thumb',
      });
    }
  }

  return reviews;
}

// ===========================================
// SHOW-SCORE PARSER
// ===========================================

/**
 * Parse reviews from Show-Score
 * Show-Score has both critic and audience reviews
 */
export function parseShowScoreReviews(html: string, showTitle: string): RawReview[] {
  const reviews: RawReview[] = [];

  // Show-Score displays critic reviews with scores and excerpts
  // Look for their review card format

  const reviewPattern = /<div[^>]*class="[^"]*critic-review[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
  const reviewBlocks = html.match(reviewPattern) || [];

  for (const block of reviewBlocks) {
    try {
      // Extract outlet
      const outletMatch = block.match(/class="[^"]*outlet[^"]*"[^>]*>([^<]+)/i) ||
        block.match(/class="[^"]*publication[^"]*"[^>]*>([^<]+)/i);
      const outletName = outletMatch ? extractText(outletMatch[1]) : null;

      if (!outletName) continue;

      // Extract score (Show-Score often shows a numeric score)
      const scoreMatch = block.match(/class="[^"]*score[^"]*"[^>]*>(\d+)/i);
      const originalRating = scoreMatch ? scoreMatch[1] : undefined;

      // Extract critic
      const criticMatch = block.match(/class="[^"]*critic[^"]*"[^>]*>([^<]+)/i);
      const criticName = criticMatch ? extractText(criticMatch[1]) : undefined;

      // Extract URL
      const urlMatch = block.match(/href="([^"]+)"/i);
      const url = urlMatch ? urlMatch[1] : undefined;

      // Extract excerpt
      const excerptMatch = block.match(/class="[^"]*excerpt[^"]*"[^>]*>([^<]+)/i) ||
        block.match(/class="[^"]*quote[^"]*"[^>]*>([^<]+)/i);
      const excerpt = excerptMatch ? extractText(excerptMatch[1]) : undefined;

      reviews.push({
        source: 'Show-Score',
        outletName,
        criticName,
        url,
        originalRating,
        excerpt,
        ratingType: originalRating ? 'numeric' : undefined,
        maxScale: originalRating ? 100 : undefined,
      });
    } catch (error) {
      console.warn(`Error parsing Show-Score review block: ${error}`);
    }
  }

  return reviews;
}

// ===========================================
// GENERIC REVIEW PAGE PARSER
// ===========================================

/**
 * Try to parse review data from a generic outlet's review page
 * This is a heuristic approach for when we know the outlet but not the format
 */
export function parseGenericReviewPage(
  html: string,
  outletName: string
): RawReview | null {
  try {
    // Try to find a rating in various formats
    let originalRating: string | undefined;
    let ratingType: RawReview['ratingType'];

    // Star ratings
    const starMatch = html.match(/(\d+(?:\.\d+)?)\s*(?:\/|out of)\s*(\d+)\s*stars?/i);
    if (starMatch) {
      originalRating = `${starMatch[1]}/${starMatch[2]}`;
      ratingType = 'stars';
    }

    // Letter grade
    if (!originalRating) {
      const gradeMatch = html.match(/grade[:\s]+([A-F][+-]?)/i) ||
        html.match(/rating[:\s]+([A-F][+-]?)/i);
      if (gradeMatch) {
        originalRating = gradeMatch[1];
        ratingType = 'letter';
      }
    }

    // Numeric score
    if (!originalRating) {
      const numericMatch = html.match(/score[:\s]+(\d+)\s*(?:\/\s*(\d+))?/i) ||
        html.match(/rating[:\s]+(\d+)\s*(?:\/\s*(\d+))?/i);
      if (numericMatch) {
        originalRating = numericMatch[2]
          ? `${numericMatch[1]}/${numericMatch[2]}`
          : numericMatch[1];
        ratingType = 'numeric';
      }
    }

    // Extract critic name from byline
    const bylineMatch = html.match(/by\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/);
    const criticName = bylineMatch ? bylineMatch[1] : undefined;

    // Extract date
    const dateMatch = html.match(/(\d{4}-\d{2}-\d{2})/) ||
      html.match(/(\w+\s+\d{1,2},?\s+\d{4})/);
    let publishDate: string | undefined;
    if (dateMatch) {
      try {
        const date = new Date(dateMatch[1]);
        if (!isNaN(date.getTime())) {
          publishDate = date.toISOString().split('T')[0];
        }
      } catch {
        // Ignore date parsing errors
      }
    }

    // Extract a potential pull quote (first quoted text or summary)
    const quoteMatch = html.match(/"([^"]{30,200})"/);
    const excerpt = quoteMatch ? quoteMatch[1] : undefined;

    return {
      source: 'direct',
      outletName,
      criticName,
      publishDate,
      originalRating,
      ratingType,
      excerpt,
    };
  } catch (error) {
    console.warn(`Error parsing generic review page for ${outletName}: ${error}`);
    return null;
  }
}

// ===========================================
// FETCH ORCHESTRATOR
// ===========================================

export interface FetchOptions {
  sources?: ('broadwayworld' | 'didtheylikeit' | 'showscore' | 'direct')[];
  verbose?: boolean;
  timeout?: number;
}

/**
 * Fetch reviews from all configured sources for a show
 */
export async function fetchReviewsForShow(
  showTitle: string,
  showSlug: string,
  options: FetchOptions = {}
): Promise<{ reviews: RawReview[]; errors: string[] }> {
  const { sources = ['broadwayworld', 'didtheylikeit', 'showscore'], verbose = false } = options;
  const reviews: RawReview[] = [];
  const errors: string[] = [];

  // URL-encode show title for searches
  const encodedTitle = encodeURIComponent(showTitle);
  const slugifiedTitle = showSlug || showTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-');

  for (const source of sources) {
    try {
      if (verbose) console.log(`Fetching from ${source}...`);

      let html: string;
      let parsedReviews: RawReview[];

      switch (source) {
        case 'broadwayworld':
          // BWW review aggregation page pattern (may need adjustment)
          const bwwUrl = `https://www.broadwayworld.com/shows/${slugifiedTitle}/reviews`;
          try {
            html = await fetchWithRetry(bwwUrl, { timeout: options.timeout });
            parsedReviews = parseBroadwayWorldReviews(html, showTitle);
            reviews.push(...parsedReviews);
            if (verbose) console.log(`  Found ${parsedReviews.length} reviews from BWW`);
          } catch (error) {
            errors.push(`BroadwayWorld: ${(error as Error).message}`);
          }
          break;

        case 'didtheylikeit':
          // DidTheyLikeIt URL pattern
          const dtliUrl = `https://didtheylikeit.com/show/${slugifiedTitle}`;
          try {
            html = await fetchWithRetry(dtliUrl, { timeout: options.timeout });
            parsedReviews = parseDidTheyLikeItReviews(html, showTitle);
            reviews.push(...parsedReviews);
            if (verbose) console.log(`  Found ${parsedReviews.length} reviews from DTLI`);
          } catch (error) {
            errors.push(`DidTheyLikeIt: ${(error as Error).message}`);
          }
          break;

        case 'showscore':
          // Show-Score URL pattern
          const ssUrl = `https://www.show-score.com/broadway/${slugifiedTitle}`;
          try {
            html = await fetchWithRetry(ssUrl, { timeout: options.timeout });
            parsedReviews = parseShowScoreReviews(html, showTitle);
            reviews.push(...parsedReviews);
            if (verbose) console.log(`  Found ${parsedReviews.length} reviews from Show-Score`);
          } catch (error) {
            errors.push(`Show-Score: ${(error as Error).message}`);
          }
          break;

        default:
          errors.push(`Unknown source: ${source}`);
      }
    } catch (error) {
      errors.push(`${source}: ${(error as Error).message}`);
    }
  }

  return { reviews, errors };
}

// ===========================================
// DIRECT OUTLET FETCHER
// ===========================================

/**
 * Fetch review directly from an outlet URL
 */
export async function fetchDirectReview(
  url: string,
  outletName?: string
): Promise<{ review: RawReview | null; error?: string }> {
  try {
    const html = await fetchWithRetry(url);

    // Determine outlet from URL if not provided
    const outlet = outletName || findOutletConfig(url)?.name || new URL(url).hostname;

    const review = parseGenericReviewPage(html, outlet);

    if (review) {
      review.url = url;
    }

    return { review };
  } catch (error) {
    return {
      review: null,
      error: (error as Error).message,
    };
  }
}

// ===========================================
// MANUAL DATA ENTRY SUPPORT
// ===========================================

/**
 * Create a RawReview from manual entry
 * This ensures manual data goes through the same normalization pipeline
 */
export function createManualReview(data: {
  outletName: string;
  criticName?: string;
  url?: string;
  publishDate?: string;
  rating?: string;
  ratingType?: RawReview['ratingType'];
  maxScale?: number;
  excerpt?: string;
  designation?: string;
}): RawReview {
  return {
    source: 'manual',
    outletName: data.outletName,
    criticName: data.criticName,
    url: data.url,
    publishDate: data.publishDate,
    originalRating: data.rating,
    ratingType: data.ratingType,
    maxScale: data.maxScale,
    excerpt: data.excerpt,
    designation: data.designation,
  };
}
