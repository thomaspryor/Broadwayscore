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

import { RawReview, OutletConfig } from './types';
import { findOutletConfig, getSearchableOutlets, OUTLETS } from './config';

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

// ===========================================
// DIRECT OUTLET FETCHING
// ===========================================

/**
 * Search result from an outlet search page
 */
export interface OutletSearchResult {
  outletId: string;
  outletName: string;
  url: string;
  title: string;
  snippet?: string;
  date?: string;
}

/**
 * Parse search results from a generic search page
 * Looks for article links that might be reviews
 */
export function parseSearchResults(
  html: string,
  outlet: OutletConfig,
  showTitle: string
): OutletSearchResult[] {
  const results: OutletSearchResult[] = [];
  const showTitleLower = showTitle.toLowerCase();

  // Common patterns for search result items
  const articlePatterns = [
    /<article[^>]*>([\s\S]*?)<\/article>/gi,
    /<div[^>]*class="[^"]*(?:result|item|post|article)[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
    /<li[^>]*class="[^"]*(?:result|item|post)[^"]*"[^>]*>([\s\S]*?)<\/li>/gi,
  ];

  for (const pattern of articlePatterns) {
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const block = match[1] || match[0];

      // Extract URL
      const urlMatch = block.match(/href="([^"]+)"/i);
      if (!urlMatch) continue;
      const url = urlMatch[1];

      // Skip if URL doesn't look like it's from this outlet's domain
      if (outlet.domain && !url.includes(outlet.domain) && !url.startsWith('/')) continue;

      // Extract title
      const titleMatch = block.match(/<h[1-6][^>]*>([^<]+)<\/h[1-6]>/i) ||
        block.match(/<a[^>]*>([^<]+)<\/a>/i);
      if (!titleMatch) continue;
      const title = extractText(titleMatch[1]);

      // Check if title mentions the show (basic relevance filter)
      if (!title.toLowerCase().includes(showTitleLower.split(' ')[0])) continue;

      // Check if it looks like a review
      const isReview = /review/i.test(title) || /review/i.test(block);

      if (isReview || title.toLowerCase().includes(showTitleLower)) {
        // Extract snippet/description
        const snippetMatch = block.match(/<p[^>]*>([^<]+)<\/p>/i);
        const snippet = snippetMatch ? extractText(snippetMatch[1]) : undefined;

        // Extract date
        const dateMatch = block.match(/(\d{4}-\d{2}-\d{2})/) ||
          block.match(/<time[^>]*>([^<]+)<\/time>/i);
        const date = dateMatch ? extractText(dateMatch[1]) : undefined;

        // Make URL absolute if relative
        let absoluteUrl = url;
        if (url.startsWith('/') && outlet.domain) {
          absoluteUrl = `https://${outlet.domain}${url}`;
        }

        results.push({
          outletId: outlet.id,
          outletName: outlet.name,
          url: absoluteUrl,
          title,
          snippet,
          date,
        });
      }
    }
  }

  return results;
}

/**
 * Fetch reviews from all configured outlets directly
 */
export async function fetchFromAllOutlets(
  showTitle: string,
  options: {
    verbose?: boolean;
    timeout?: number;
    tiers?: (1 | 2 | 3)[];
    concurrency?: number;
  } = {}
): Promise<{
  reviews: RawReview[];
  searchResults: OutletSearchResult[];
  errors: string[];
}> {
  const {
    verbose = false,
    timeout = 15000,
    tiers = [1, 2, 3],
    concurrency = 5,
  } = options;

  const reviews: RawReview[] = [];
  const searchResults: OutletSearchResult[] = [];
  const errors: string[] = [];

  // Get all searchable outlets for requested tiers
  const outlets = getSearchableOutlets().filter(o => tiers.includes(o.tier));

  if (verbose) {
    console.log(`\nSearching ${outlets.length} outlets for "${showTitle}"...`);
  }

  // Process outlets in batches for controlled concurrency
  for (let i = 0; i < outlets.length; i += concurrency) {
    const batch = outlets.slice(i, i + concurrency);

    const batchPromises = batch.map(async (outlet) => {
      if (!outlet.searchUrl) return;

      const searchUrl = outlet.searchUrl(showTitle);
      if (verbose) {
        console.log(`  Searching ${outlet.name}...`);
      }

      try {
        const html = await fetchWithRetry(searchUrl, {
          timeout,
          maxRetries: 2, // Fewer retries for speed
        });

        const results = parseSearchResults(html, outlet, showTitle);

        if (results.length > 0) {
          searchResults.push(...results);
          if (verbose) {
            console.log(`    Found ${results.length} potential reviews at ${outlet.name}`);
          }
        }
      } catch (error) {
        // Only log errors in verbose mode - many will fail for legitimate reasons
        if (verbose) {
          console.log(`    ${outlet.name}: ${(error as Error).message}`);
        }
        errors.push(`${outlet.name}: ${(error as Error).message}`);
      }
    });

    await Promise.all(batchPromises);
  }

  // Now fetch the actual review pages for found results
  if (searchResults.length > 0 && verbose) {
    console.log(`\nFetching ${searchResults.length} potential review pages...`);
  }

  for (const result of searchResults.slice(0, 20)) { // Limit to avoid too many requests
    try {
      const { review, error } = await fetchDirectReview(result.url, result.outletName);
      if (review) {
        reviews.push(review);
      }
      if (error && verbose) {
        console.log(`    Error fetching ${result.outletName}: ${error}`);
      }
    } catch (error) {
      if (verbose) {
        console.log(`    Error fetching ${result.url}: ${error}`);
      }
    }
  }

  return { reviews, searchResults, errors };
}

// ===========================================
// WEB SEARCH DISCOVERY
// ===========================================

/**
 * Discovered review from web search
 */
export interface DiscoveredReview {
  url: string;
  title: string;
  outlet: string;
  snippet?: string;
  isKnownOutlet: boolean;
  outletConfig?: OutletConfig;
}

/**
 * Search the web for additional reviews not in our outlet list
 * This uses a generic search to find reviews we might have missed
 */
export async function discoverAdditionalReviews(
  showTitle: string,
  options: {
    verbose?: boolean;
    existingUrls?: string[];
  } = {}
): Promise<{
  discovered: DiscoveredReview[];
  searchQueries: string[];
}> {
  const { verbose = false, existingUrls = [] } = options;
  const discovered: DiscoveredReview[] = [];
  const searchQueries: string[] = [];

  // Build search queries
  const queries = [
    `"${showTitle}" broadway review`,
    `"${showTitle}" theater review 2025`,
    `"${showTitle}" musical review`,
  ];

  if (verbose) {
    console.log('\nSearching for additional reviews...');
    console.log(`Queries: ${queries.join(', ')}`);
  }

  // Note: Actual web search would require an API (Google Custom Search, Bing, etc.)
  // For now, this function returns the queries and is designed to be extended
  // The CLI will prompt the user to manually check these searches

  searchQueries.push(...queries);

  return { discovered, searchQueries };
}

/**
 * Check if a URL belongs to a known outlet
 */
export function identifyOutletFromUrl(url: string): {
  isKnown: boolean;
  outlet?: OutletConfig;
  domain: string;
} {
  try {
    const urlObj = new URL(url);
    const domain = urlObj.hostname.replace(/^www\./, '');

    const outlet = OUTLETS.find(o => {
      if (o.domain && domain.includes(o.domain.replace(/^www\./, ''))) {
        return true;
      }
      return false;
    });

    return {
      isKnown: !!outlet,
      outlet,
      domain,
    };
  } catch {
    return {
      isKnown: false,
      domain: url,
    };
  }
}

// ===========================================
// COMPREHENSIVE FETCH
// ===========================================

export interface ComprehensiveFetchOptions {
  sources?: ('aggregators' | 'outlets' | 'websearch')[];
  verbose?: boolean;
  timeout?: number;
  tiers?: (1 | 2 | 3)[];
}

export interface ComprehensiveFetchResult {
  reviews: RawReview[];
  searchResults: OutletSearchResult[];
  webSearchQueries: string[];
  errors: string[];
  summary: {
    aggregatorReviews: number;
    outletReviews: number;
    potentialReviews: number;
  };
}

/**
 * Comprehensive fetch from all sources
 */
export async function fetchComprehensive(
  showTitle: string,
  showSlug: string,
  options: ComprehensiveFetchOptions = {}
): Promise<ComprehensiveFetchResult> {
  const {
    sources = ['aggregators', 'outlets'],
    verbose = false,
    timeout = 15000,
    tiers = [1, 2, 3],
  } = options;

  const allReviews: RawReview[] = [];
  const allSearchResults: OutletSearchResult[] = [];
  const allErrors: string[] = [];
  let webSearchQueries: string[] = [];

  let aggregatorReviews = 0;
  let outletReviews = 0;

  // 1. Fetch from aggregators
  if (sources.includes('aggregators')) {
    if (verbose) console.log('\n=== Fetching from Aggregators ===');
    const { reviews, errors } = await fetchReviewsForShow(showTitle, showSlug, {
      sources: ['broadwayworld', 'didtheylikeit', 'showscore'],
      verbose,
      timeout,
    });
    aggregatorReviews = reviews.length;
    allReviews.push(...reviews);
    allErrors.push(...errors);
  }

  // 2. Fetch from all outlets directly
  if (sources.includes('outlets')) {
    if (verbose) console.log('\n=== Searching All Outlets ===');
    const { reviews, searchResults, errors } = await fetchFromAllOutlets(showTitle, {
      verbose,
      timeout,
      tiers,
    });
    outletReviews = reviews.length;
    allReviews.push(...reviews);
    allSearchResults.push(...searchResults);
    allErrors.push(...errors);
  }

  // 3. Web search for additional reviews
  if (sources.includes('websearch')) {
    if (verbose) console.log('\n=== Web Search Discovery ===');
    const existingUrls = allReviews.map(r => r.url).filter(Boolean) as string[];
    const { discovered, searchQueries } = await discoverAdditionalReviews(showTitle, {
      verbose,
      existingUrls,
    });

    // Add discovered reviews
    for (const d of discovered) {
      if (d.outletConfig) {
        allReviews.push({
          source: 'websearch',
          outletName: d.outlet,
          url: d.url,
          excerpt: d.snippet,
        });
      }
    }

    webSearchQueries = searchQueries;
  }

  return {
    reviews: allReviews,
    searchResults: allSearchResults,
    webSearchQueries,
    errors: allErrors,
    summary: {
      aggregatorReviews,
      outletReviews,
      potentialReviews: allSearchResults.length,
    },
  };
}
