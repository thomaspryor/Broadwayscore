/**
 * Search API-based Review Fetcher
 *
 * Uses web search APIs to find and extract Broadway reviews.
 * This approach is more reliable than direct scraping because:
 * 1. Search engines already index the content
 * 2. Less likely to get blocked by anti-scraping measures
 * 3. Can discover reviews from outlets we don't have configured
 *
 * Supported search providers:
 * - SerpAPI (serpapi.com) - Google search results
 * - Brave Search API (brave.com/search/api)
 * - Custom/manual search input
 */

import { RawReview } from './types';
import { findOutletConfig, OUTLETS, TEXT_BUCKET_MAP } from './config';

// ===========================================
// TYPES
// ===========================================

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source?: string;
  date?: string;
}

export interface SearchAPIConfig {
  provider: 'serpapi' | 'brave' | 'manual';
  apiKey?: string;
}

export interface ParsedReviewFromSearch {
  outlet: string;
  outletId?: string;
  criticName?: string;
  url: string;
  sentiment?: 'rave' | 'positive' | 'mixed' | 'negative' | 'pan';
  rating?: string;
  pullQuote?: string;
  publishDate?: string;
  isKnownOutlet: boolean;
  tier?: 1 | 2 | 3;
}

// ===========================================
// SEARCH API CLIENTS
// ===========================================

/**
 * Fetch search results using SerpAPI
 */
export async function searchWithSerpAPI(
  query: string,
  apiKey: string,
  options: { num?: number } = {}
): Promise<SearchResult[]> {
  const { num = 20 } = options;

  const params = new URLSearchParams({
    q: query,
    api_key: apiKey,
    engine: 'google',
    num: String(num),
  });

  const response = await fetch(`https://serpapi.com/search?${params}`);

  if (!response.ok) {
    throw new Error(`SerpAPI error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as { organic_results?: Array<{ title: string; link: string; snippet?: string; source?: string; date?: string }> };

  return (data.organic_results || []).map((result) => ({
    title: result.title,
    url: result.link,
    snippet: result.snippet || '',
    source: result.source,
    date: result.date,
  }));
}

/**
 * Fetch search results using Brave Search API
 */
export async function searchWithBrave(
  query: string,
  apiKey: string,
  options: { count?: number } = {}
): Promise<SearchResult[]> {
  const { count = 20 } = options;

  const params = new URLSearchParams({
    q: query,
    count: String(count),
  });

  const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
    headers: {
      'X-Subscription-Token': apiKey,
      'Accept': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Brave Search error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as { web?: { results?: Array<{ title: string; url: string; description?: string; meta_url?: { hostname?: string }; age?: string }> } };

  return (data.web?.results || []).map((result) => ({
    title: result.title,
    url: result.url,
    snippet: result.description || '',
    source: result.meta_url?.hostname,
    date: result.age,
  }));
}

// ===========================================
// REVIEW EXTRACTION FROM SEARCH RESULTS
// ===========================================

/**
 * Extract outlet name from URL or title
 */
export function extractOutletFromResult(result: SearchResult): {
  name: string;
  config?: ReturnType<typeof findOutletConfig>;
  isKnown: boolean;
} {
  // Try to find outlet from URL first
  try {
    const url = new URL(result.url);
    const domain = url.hostname.replace(/^www\./, '');

    const config = OUTLETS.find(o =>
      o.domain && domain.includes(o.domain.replace(/^www\./, ''))
    );

    if (config) {
      return { name: config.name, config, isKnown: true };
    }

    // Check for common patterns in title
    for (const outlet of OUTLETS) {
      if (result.title.includes(outlet.name) ||
          outlet.aliases.some(a => result.title.includes(a))) {
        return { name: outlet.name, config: outlet, isKnown: true };
      }
    }

    // Use domain as outlet name for unknown outlets
    return { name: formatDomainAsOutlet(domain), isKnown: false };
  } catch {
    return { name: 'Unknown', isKnown: false };
  }
}

/**
 * Format a domain as a readable outlet name
 */
function formatDomainAsOutlet(domain: string): string {
  // Remove common suffixes
  const name = domain
    .replace(/\.(com|org|net|co\.uk|io)$/, '')
    .replace(/[-_]/g, ' ');

  // Title case
  return name
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Extract critic name from snippet or title
 */
export function extractCriticName(result: SearchResult): string | undefined {
  const text = `${result.title} ${result.snippet}`;

  // Common patterns for critic bylines
  const patterns = [
    /by\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/,
    /review\s+by\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/i,
    /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\s+reviews/i,
    /critic\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const name = match[1].trim();
      // Filter out common false positives
      if (!['The New', 'New York', 'Los Angeles', 'Broadway', 'Theater', 'Theatre'].includes(name)) {
        return name;
      }
    }
  }

  return undefined;
}

/**
 * Analyze sentiment from snippet text
 */
export function analyzeSentiment(text: string): {
  sentiment: 'rave' | 'positive' | 'mixed' | 'negative' | 'pan';
  confidence: number;
} {
  const lowerText = text.toLowerCase();

  // Positive indicators
  const raveWords = ['masterpiece', 'brilliant', 'stunning', 'extraordinary', 'outstanding', 'phenomenal', 'magnificent', 'triumph'];
  const positiveWords = ['excellent', 'great', 'wonderful', 'delightful', 'enjoyable', 'compelling', 'engaging', 'impressive', 'strong', 'solid', 'powerful'];
  const negativeWords = ['disappointing', 'weak', 'dull', 'boring', 'tedious', 'flat', 'lackluster', 'mediocre', 'uneven'];
  const panWords = ['terrible', 'awful', 'disaster', 'painful', 'waste', 'skip', 'avoid'];
  const mixedWords = ['mixed', 'uneven', 'inconsistent', 'some', 'moments', 'but', 'however', 'although'];

  let raveScore = 0;
  let positiveScore = 0;
  let negativeScore = 0;
  let panScore = 0;
  let mixedScore = 0;

  for (const word of raveWords) {
    if (lowerText.includes(word)) raveScore += 2;
  }
  for (const word of positiveWords) {
    if (lowerText.includes(word)) positiveScore += 1;
  }
  for (const word of negativeWords) {
    if (lowerText.includes(word)) negativeScore += 1;
  }
  for (const word of panWords) {
    if (lowerText.includes(word)) panScore += 2;
  }
  for (const word of mixedWords) {
    if (lowerText.includes(word)) mixedScore += 0.5;
  }

  const totalScore = raveScore + positiveScore + negativeScore + panScore + mixedScore;
  const confidence = Math.min(totalScore / 5, 1);

  if (raveScore >= 2) return { sentiment: 'rave', confidence };
  if (panScore >= 2) return { sentiment: 'pan', confidence };
  if (positiveScore > negativeScore + mixedScore) return { sentiment: 'positive', confidence };
  if (negativeScore > positiveScore) return { sentiment: 'negative', confidence };
  if (mixedScore > 0 || (positiveScore > 0 && negativeScore > 0)) return { sentiment: 'mixed', confidence };

  // Default to positive if we found review-like content
  return { sentiment: 'positive', confidence: 0.3 };
}

/**
 * Extract star rating from text
 */
export function extractRating(text: string): string | undefined {
  // Star ratings
  const starMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:\/|out of)\s*(\d+)\s*stars?/i) ||
                    text.match(/(\d+(?:\.\d+)?)\s*stars?/i);
  if (starMatch) {
    if (starMatch[2]) {
      return `${starMatch[1]}/${starMatch[2]}`;
    }
    return `${starMatch[1]}/5`; // Assume 5-star scale
  }

  // Letter grades
  const gradeMatch = text.match(/\b([A-F][+-]?)\b/) ||
                     text.match(/grade[:\s]+([A-F][+-]?)/i);
  if (gradeMatch && gradeMatch[1].length <= 2) {
    return gradeMatch[1];
  }

  // Numeric scores
  const numericMatch = text.match(/(\d+)\s*(?:\/|out of)\s*100/i) ||
                       text.match(/score[:\s]+(\d+)/i);
  if (numericMatch) {
    return `${numericMatch[1]}/100`;
  }

  return undefined;
}

/**
 * Parse a search result into a review structure
 */
export function parseSearchResult(result: SearchResult, showTitle: string): ParsedReviewFromSearch | null {
  // Check if this looks like a review
  const titleLower = result.title.toLowerCase();
  const snippetLower = result.snippet.toLowerCase();
  const showTitleLower = showTitle.toLowerCase();
  const showFirstWord = showTitleLower.split(' ')[0];

  // Must mention the show
  const mentionsShow = titleLower.includes(showFirstWord) ||
                       snippetLower.includes(showFirstWord) ||
                       titleLower.includes(showTitleLower);

  if (!mentionsShow) return null;

  // Should look like a review
  const isReview = /review/i.test(result.title) ||
                   /review/i.test(result.snippet) ||
                   /critic/i.test(result.snippet);

  if (!isReview) return null;

  const { name: outlet, config, isKnown } = extractOutletFromResult(result);
  const criticName = extractCriticName(result);
  const { sentiment } = analyzeSentiment(result.snippet);
  const rating = extractRating(result.snippet);

  // Extract a potential pull quote
  const quoteMatch = result.snippet.match(/"([^"]{20,150})"/);
  const pullQuote = quoteMatch ? quoteMatch[1] : undefined;

  return {
    outlet,
    outletId: config?.id,
    criticName,
    url: result.url,
    sentiment,
    rating,
    pullQuote,
    publishDate: result.date,
    isKnownOutlet: isKnown,
    tier: config?.tier,
  };
}

// ===========================================
// MAIN SEARCH FUNCTION
// ===========================================

export interface SearchFetchOptions {
  apiConfig: SearchAPIConfig;
  verbose?: boolean;
  maxResults?: number;
}

export interface SearchFetchResult {
  reviews: ParsedReviewFromSearch[];
  rawResults: SearchResult[];
  queries: string[];
  errors: string[];
}

/**
 * Search for reviews using configured search API
 */
export async function searchForReviews(
  showTitle: string,
  options: SearchFetchOptions
): Promise<SearchFetchResult> {
  const { apiConfig, verbose = false, maxResults = 30 } = options;

  const reviews: ParsedReviewFromSearch[] = [];
  const rawResults: SearchResult[] = [];
  const errors: string[] = [];

  // Build search queries
  const queries = [
    `"${showTitle}" broadway review`,
    `"${showTitle}" theater review critic`,
    `"${showTitle}" broadway opening night review`,
  ];

  if (verbose) {
    console.log(`\nSearching for "${showTitle}" reviews...`);
    console.log(`Provider: ${apiConfig.provider}`);
    console.log(`Queries: ${queries.join(', ')}`);
  }

  for (const query of queries) {
    try {
      let results: SearchResult[] = [];

      switch (apiConfig.provider) {
        case 'serpapi':
          if (!apiConfig.apiKey) {
            errors.push('SerpAPI requires an API key (set SERPAPI_KEY env var)');
            continue;
          }
          results = await searchWithSerpAPI(query, apiConfig.apiKey, { num: maxResults });
          break;

        case 'brave':
          if (!apiConfig.apiKey) {
            errors.push('Brave Search requires an API key (set BRAVE_API_KEY env var)');
            continue;
          }
          results = await searchWithBrave(query, apiConfig.apiKey, { count: maxResults });
          break;

        case 'manual':
          // Manual mode - results will be provided externally
          if (verbose) {
            console.log(`\nManual mode - please run these searches and provide results:`);
            console.log(`  ${query}`);
          }
          continue;
      }

      rawResults.push(...results);

      if (verbose) {
        console.log(`  Query "${query.substring(0, 40)}..." returned ${results.length} results`);
      }

    } catch (error) {
      errors.push(`Search error for "${query}": ${(error as Error).message}`);
    }
  }

  // Parse results into reviews
  const seenUrls = new Set<string>();

  for (const result of rawResults) {
    // Deduplicate by URL
    if (seenUrls.has(result.url)) continue;
    seenUrls.add(result.url);

    const parsed = parseSearchResult(result, showTitle);
    if (parsed) {
      reviews.push(parsed);
    }
  }

  // Sort by tier (known outlets first), then by outlet name
  reviews.sort((a, b) => {
    if (a.isKnownOutlet !== b.isKnownOutlet) {
      return a.isKnownOutlet ? -1 : 1;
    }
    if (a.tier && b.tier && a.tier !== b.tier) {
      return a.tier - b.tier;
    }
    return a.outlet.localeCompare(b.outlet);
  });

  if (verbose) {
    console.log(`\nFound ${reviews.length} reviews from ${seenUrls.size} unique URLs`);
    console.log(`  Known outlets: ${reviews.filter(r => r.isKnownOutlet).length}`);
    console.log(`  New outlets: ${reviews.filter(r => !r.isKnownOutlet).length}`);
  }

  return { reviews, rawResults, queries, errors };
}

/**
 * Convert parsed search results to RawReview format for the normalizer
 */
export function toRawReviews(parsed: ParsedReviewFromSearch[]): RawReview[] {
  return parsed.map(p => {
    // Map sentiment to rating type
    let originalRating: string | undefined = p.rating;
    let ratingType: RawReview['ratingType'] = undefined;

    if (p.rating) {
      if (p.rating.includes('/')) {
        ratingType = p.rating.includes('100') ? 'numeric' : 'stars';
      } else if (/^[A-F][+-]?$/.test(p.rating)) {
        ratingType = 'letter';
      }
    } else if (p.sentiment) {
      // Use sentiment as rating if no explicit rating
      originalRating = p.sentiment;
      ratingType = 'bucket';
    }

    return {
      source: 'search',
      outletName: p.outlet,
      criticName: p.criticName,
      url: p.url,
      publishDate: p.publishDate,
      originalRating,
      ratingType,
      excerpt: p.pullQuote,
    };
  });
}

// ===========================================
// CLI HELPER FOR MANUAL INPUT
// ===========================================

/**
 * Parse manually provided search results (from clipboard/file)
 * Expected format: JSON array of SearchResult objects
 */
export function parseManualSearchResults(input: string): SearchResult[] {
  try {
    const parsed = JSON.parse(input);
    if (Array.isArray(parsed)) {
      return parsed.filter(r => r.title && r.url);
    }
    return [];
  } catch {
    // Try to parse as simple URL list
    const lines = input.split('\n').filter(l => l.trim());
    return lines.map(line => {
      const [url, title] = line.split('|').map(s => s.trim());
      return { title: title || url, url, snippet: '' };
    });
  }
}

// ===========================================
// PRIORITIZED SEARCH (Aggregators → Outlets → Web)
// ===========================================

/**
 * Aggregator sites that collect reviews
 */
const AGGREGATORS = [
  { name: 'Did They Like It', domain: 'didtheylikeit.com', searchPattern: 'site:didtheylikeit.com' },
  { name: 'Show-Score', domain: 'show-score.com', searchPattern: 'site:show-score.com' },
  { name: 'BroadwayWorld', domain: 'broadwayworld.com', searchPattern: 'site:broadwayworld.com reviews' },
];

export interface PrioritizedSearchResult {
  aggregatorReviews: ParsedReviewFromSearch[];
  outletReviews: ParsedReviewFromSearch[];
  webSearchReviews: ParsedReviewFromSearch[];
  allReviews: ParsedReviewFromSearch[];
  rawResults: SearchResult[];
  queries: string[];
  errors: string[];
  summary: {
    fromAggregators: number;
    fromOutlets: number;
    fromWebSearch: number;
    total: number;
  };
}

/**
 * Search for reviews in prioritized order:
 * 1. Aggregators (DidTheyLikeIt, Show-Score, BroadwayWorld)
 * 2. Individual outlets (NYT, Variety, etc.)
 * 3. General web search
 */
export async function searchPrioritized(
  showTitle: string,
  options: SearchFetchOptions
): Promise<PrioritizedSearchResult> {
  const { apiConfig, verbose = false, maxResults = 20 } = options;

  const aggregatorReviews: ParsedReviewFromSearch[] = [];
  const outletReviews: ParsedReviewFromSearch[] = [];
  const webSearchReviews: ParsedReviewFromSearch[] = [];
  const rawResults: SearchResult[] = [];
  const queries: string[] = [];
  const errors: string[] = [];
  const seenUrls = new Set<string>();

  if (verbose) {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`PRIORITIZED SEARCH: "${showTitle}"`);
    console.log(`${'='.repeat(50)}`);
  }

  // Helper to execute search
  const executeSearch = async (query: string): Promise<SearchResult[]> => {
    queries.push(query);
    try {
      if (apiConfig.provider === 'serpapi' && apiConfig.apiKey) {
        return await searchWithSerpAPI(query, apiConfig.apiKey, { num: maxResults });
      } else if (apiConfig.provider === 'brave' && apiConfig.apiKey) {
        return await searchWithBrave(query, apiConfig.apiKey, { count: maxResults });
      }
      return [];
    } catch (error) {
      errors.push(`Search error: ${(error as Error).message}`);
      return [];
    }
  };

  // =============================================
  // STEP 1: Search Aggregators
  // =============================================
  if (verbose) console.log(`\n[STEP 1] Searching aggregators...`);

  for (const agg of AGGREGATORS) {
    const query = `${agg.searchPattern} "${showTitle}" broadway`;
    if (verbose) console.log(`  Searching ${agg.name}...`);

    const results = await executeSearch(query);
    rawResults.push(...results);

    // Parse reviews from aggregator results
    for (const result of results) {
      if (seenUrls.has(result.url)) continue;

      // Aggregator pages often list multiple reviews in snippets
      // Extract what we can from the search result
      const parsed = parseSearchResult(result, showTitle);
      if (parsed) {
        seenUrls.add(result.url);
        aggregatorReviews.push(parsed);
      }
    }

    if (verbose) console.log(`    Found ${results.length} results`);
  }

  // =============================================
  // STEP 2: Search Individual Outlets
  // =============================================
  if (verbose) console.log(`\n[STEP 2] Searching individual outlets...`);

  // Key outlets to search directly
  const keyOutlets = [
    { name: 'New York Times', pattern: 'site:nytimes.com theater review' },
    { name: 'Variety', pattern: 'site:variety.com legit review' },
    { name: 'Vulture', pattern: 'site:vulture.com review' },
    { name: 'Hollywood Reporter', pattern: 'site:hollywoodreporter.com review' },
    { name: 'Washington Post', pattern: 'site:washingtonpost.com theater review' },
    { name: 'Time Out', pattern: 'site:timeout.com theater review' },
    { name: 'Deadline', pattern: 'site:deadline.com review' },
    { name: 'TheaterMania', pattern: 'site:theatermania.com review' },
    { name: 'Playbill', pattern: 'site:playbill.com review' },
  ];

  for (const outlet of keyOutlets) {
    const query = `${outlet.pattern} "${showTitle}"`;
    const results = await executeSearch(query);
    rawResults.push(...results);

    for (const result of results) {
      if (seenUrls.has(result.url)) continue;

      const parsed = parseSearchResult(result, showTitle);
      if (parsed) {
        seenUrls.add(result.url);
        outletReviews.push(parsed);
      }
    }
  }

  if (verbose) console.log(`  Found ${outletReviews.length} outlet reviews`);

  // =============================================
  // STEP 3: General Web Search
  // =============================================
  if (verbose) console.log(`\n[STEP 3] General web search for additional reviews...`);

  const webQueries = [
    `"${showTitle}" broadway review 2026`,
    `"${showTitle}" broadway critic review`,
    `"${showTitle}" theater review opening night`,
  ];

  for (const query of webQueries) {
    const results = await executeSearch(query);
    rawResults.push(...results);

    for (const result of results) {
      if (seenUrls.has(result.url)) continue;

      const parsed = parseSearchResult(result, showTitle);
      if (parsed) {
        seenUrls.add(result.url);
        webSearchReviews.push(parsed);
      }
    }
  }

  if (verbose) console.log(`  Found ${webSearchReviews.length} additional reviews`);

  // Combine all reviews
  const allReviews = [...aggregatorReviews, ...outletReviews, ...webSearchReviews];

  // Sort by tier (known outlets first)
  allReviews.sort((a, b) => {
    if (a.isKnownOutlet !== b.isKnownOutlet) return a.isKnownOutlet ? -1 : 1;
    if (a.tier && b.tier && a.tier !== b.tier) return a.tier - b.tier;
    return a.outlet.localeCompare(b.outlet);
  });

  const summary = {
    fromAggregators: aggregatorReviews.length,
    fromOutlets: outletReviews.length,
    fromWebSearch: webSearchReviews.length,
    total: allReviews.length,
  };

  if (verbose) {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`SEARCH COMPLETE`);
    console.log(`  From aggregators: ${summary.fromAggregators}`);
    console.log(`  From outlets: ${summary.fromOutlets}`);
    console.log(`  From web search: ${summary.fromWebSearch}`);
    console.log(`  Total unique: ${summary.total}`);
    console.log(`${'='.repeat(50)}`);
  }

  return {
    aggregatorReviews,
    outletReviews,
    webSearchReviews,
    allReviews,
    rawResults,
    queries,
    errors,
    summary,
  };
}
