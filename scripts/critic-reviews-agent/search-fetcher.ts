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
