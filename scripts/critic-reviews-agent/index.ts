#!/usr/bin/env npx ts-node
/**
 * Broadway Critic Reviews Agent
 *
 * Fetches, normalizes, and deduplicates critic reviews for Broadway shows.
 *
 * Usage:
 *   # Fetch reviews for a specific show
 *   npx ts-node scripts/critic-reviews-agent/index.ts --show "two-strangers-bway-2025"
 *
 *   # Fetch from specific sources
 *   npx ts-node scripts/critic-reviews-agent/index.ts --show "two-strangers-bway-2025" --sources broadwayworld,didtheylikeit
 *
 *   # Dry run (don't write output)
 *   npx ts-node scripts/critic-reviews-agent/index.ts --show "two-strangers-bway-2025" --dry-run
 *
 *   # Process all shows
 *   npx ts-node scripts/critic-reviews-agent/index.ts --all
 *
 *   # Generate report only (don't fetch, just analyze existing data)
 *   npx ts-node scripts/critic-reviews-agent/index.ts --report
 *
 * Design Principles:
 *   - CONSISTENCY: Running twice produces identical results
 *   - DETERMINISM: Same inputs always produce same outputs
 *   - IDEMPOTENT: Safe to run multiple times
 *   - TRACEABLE: All changes are logged and can be reviewed
 */

import * as fs from 'fs';
import * as path from 'path';

import { RawReview, NormalizedReview, AgentResult } from './types';
import { normalizeReview, normalizeReviews } from './normalizer';
import { deduplicateReviews, mergeWithExisting, validateReviews } from './deduper';
import {
  fetchReviewsForShow,
  createManualReview,
  fetchComprehensive,
  fetchFromAllOutlets,
  OutletSearchResult,
} from './fetchers';
import {
  searchForReviews,
  searchPrioritized,
  toRawReviews,
  SearchAPIConfig,
  ParsedReviewFromSearch,
  PrioritizedSearchResult,
} from './search-fetcher';
import { OUTLETS, findOutletConfig, scoreToBucket, scoreToThumb, getSearchableOutlets } from './config';

// ===========================================
// FILE PATHS
// ===========================================

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const SHOWS_FILE = path.join(DATA_DIR, 'shows.json');
const REVIEWS_FILE = path.join(DATA_DIR, 'reviews.json');
const AGENT_OUTPUT_DIR = path.join(DATA_DIR, 'agent-output');

// ===========================================
// DATA LOADING
// ===========================================

interface ShowData {
  id: string;
  title: string;
  slug: string;
  status: string;
}

interface ReviewsData {
  _meta: {
    description: string;
    lastUpdated: string;
    notes?: string;
  };
  reviews: NormalizedReview[];
}

function loadShows(): ShowData[] {
  const data = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf-8'));
  return data.shows;
}

function loadReviews(): ReviewsData {
  return JSON.parse(fs.readFileSync(REVIEWS_FILE, 'utf-8'));
}

function saveReviews(data: ReviewsData): void {
  // Update lastUpdated
  data._meta.lastUpdated = new Date().toISOString().split('T')[0];

  // Sort reviews consistently
  data.reviews.sort((a, b) => {
    const showCompare = a.showId.localeCompare(b.showId);
    if (showCompare !== 0) return showCompare;
    const outletCompare = a.outletId.localeCompare(b.outletId);
    if (outletCompare !== 0) return outletCompare;
    return (a.criticName || '').localeCompare(b.criticName || '');
  });

  fs.writeFileSync(REVIEWS_FILE, JSON.stringify(data, null, 2) + '\n');
}

// ===========================================
// AGENT CORE
// ===========================================

async function processShow(
  show: ShowData,
  existingReviews: NormalizedReview[],
  options: {
    sources?: string[];
    verbose?: boolean;
    dryRun?: boolean;
    comprehensive?: boolean;
    search?: boolean;
    searchApiConfig?: SearchAPIConfig;
  } = {}
): Promise<AgentResult & { searchResults?: OutletSearchResult[]; webSearchQueries?: string[]; parsedSearchReviews?: ParsedReviewFromSearch[] }> {
  const {
    sources = ['broadwayworld', 'didtheylikeit', 'showscore'],
    verbose = false,
    dryRun = false,
    comprehensive = false,
    search = false,
    searchApiConfig,
  } = options;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Processing: ${show.title}`);
  console.log(`Show ID: ${show.id}`);
  console.log(`${'='.repeat(60)}`);

  const result: AgentResult & { searchResults?: OutletSearchResult[]; webSearchQueries?: string[]; parsedSearchReviews?: ParsedReviewFromSearch[] } = {
    showId: show.id,
    showTitle: show.title,
    reviewsFound: [],
    newReviews: [],
    updatedReviews: [],
    skippedDuplicates: 0,
    errors: [],
    sources: sources,
  };

  let rawReviews: RawReview[] = [];
  let searchResults: OutletSearchResult[] = [];
  let webSearchQueries: string[] = [];
  let parsedSearchReviews: ParsedReviewFromSearch[] = [];

  // Search API mode - use prioritized web search to find reviews
  // Order: 1) Aggregators (DTLI, Show-Score, BWW) → 2) Outlets → 3) Web search
  if (search && searchApiConfig) {
    console.log(`\nUsing Prioritized Search API (${searchApiConfig.provider})...`);
    console.log(`Order: Aggregators → Outlets → Web Search`);
    try {
      const searchResult = await searchPrioritized(show.title, {
        apiConfig: searchApiConfig,
        verbose,
        maxResults: 20,
      });

      parsedSearchReviews = searchResult.allReviews;
      rawReviews = toRawReviews(searchResult.allReviews);
      webSearchQueries = searchResult.queries;
      result.errors.push(...searchResult.errors);

      console.log(`\nSearch Results Summary:`);
      console.log(`  - From aggregators (DTLI, Show-Score, BWW): ${searchResult.summary.fromAggregators}`);
      console.log(`  - From outlets (NYT, Variety, etc.): ${searchResult.summary.fromOutlets}`);
      console.log(`  - From web search: ${searchResult.summary.fromWebSearch}`);
      console.log(`  - Total unique reviews: ${searchResult.summary.total}`);
      console.log(`  - Known outlets: ${parsedSearchReviews.filter(r => r.isKnownOutlet).length}`);
      console.log(`  - New outlets discovered: ${parsedSearchReviews.filter(r => !r.isKnownOutlet).length}`);

      if (verbose && parsedSearchReviews.length > 0) {
        console.log(`\nReviews found:`);
        for (const review of parsedSearchReviews.slice(0, 20)) {
          const tier = review.tier ? `T${review.tier}` : 'T?';
          console.log(`  ${review.isKnownOutlet ? '✓' : '?'} ${review.outlet} (${tier}): ${review.sentiment || 'unknown'}`);
          if (review.criticName) console.log(`    by ${review.criticName}`);
          console.log(`    ${review.url}`);
        }
        if (parsedSearchReviews.length > 20) {
          console.log(`  ... and ${parsedSearchReviews.length - 20} more`);
        }
      }

      result.parsedSearchReviews = parsedSearchReviews;
    } catch (error) {
      result.errors.push(`Search API error: ${(error as Error).message}`);
      console.error(`Search API error: ${(error as Error).message}`);
    }
  } else if (comprehensive) {
    // Comprehensive fetch: aggregators + all outlets + web search
    console.log(`\nComprehensive fetch from ${getSearchableOutlets().length} outlets...`);
    const fetchResult = await fetchComprehensive(show.title, show.slug, {
      sources: ['aggregators', 'outlets', 'websearch'],
      verbose,
      tiers: [1, 2, 3],
    });

    rawReviews = fetchResult.reviews;
    searchResults = fetchResult.searchResults;
    webSearchQueries = fetchResult.webSearchQueries;
    result.errors.push(...fetchResult.errors);

    console.log(`\nFetch Summary:`);
    console.log(`  - From aggregators: ${fetchResult.summary.aggregatorReviews}`);
    console.log(`  - From outlets: ${fetchResult.summary.outletReviews}`);
    console.log(`  - Potential reviews found: ${fetchResult.summary.potentialReviews}`);

    if (searchResults.length > 0) {
      result.searchResults = searchResults;
      console.log(`\nPotential review pages found:`);
      for (const sr of searchResults.slice(0, 10)) {
        console.log(`  - ${sr.outletName}: ${sr.title}`);
        console.log(`    ${sr.url}`);
      }
      if (searchResults.length > 10) {
        console.log(`  ... and ${searchResults.length - 10} more`);
      }
    }

    if (webSearchQueries.length > 0) {
      result.webSearchQueries = webSearchQueries;
      console.log(`\nWeb searches to find additional reviews:`);
      for (const query of webSearchQueries) {
        console.log(`  - https://www.google.com/search?q=${encodeURIComponent(query)}`);
      }
    }
  } else {
    // Standard fetch from aggregators only
    console.log(`\nFetching from: ${sources.join(', ')}`);
    const { reviews, errors } = await fetchReviewsForShow(
      show.title,
      show.slug,
      { sources: sources as any[], verbose }
    );
    rawReviews = reviews;
    result.errors.push(...errors);
  }

  if (result.errors.length > 0 && verbose) {
    console.log(`\nFetch errors (${result.errors.length}):`);
    for (const error of result.errors.slice(0, 5)) {
      console.log(`  - ${error}`);
    }
  }

  console.log(`\nRaw reviews fetched: ${rawReviews.length}`);

  // Normalize reviews
  const normalizedNew = normalizeReviews(rawReviews, show.id);
  console.log(`Normalized reviews: ${normalizedNew.length}`);

  // Deduplicate fetched reviews
  const { deduplicated, duplicatesRemoved } = deduplicateReviews(normalizedNew);
  result.skippedDuplicates = duplicatesRemoved;
  console.log(`After deduplication: ${deduplicated.length} (${duplicatesRemoved} duplicates removed)`);

  // Merge with existing data
  const existingForShow = existingReviews.filter(r => r.showId === show.id);
  console.log(`Existing reviews for show: ${existingForShow.length}`);

  const { merged, added, updated, unchanged } = mergeWithExisting(
    existingForShow,
    deduplicated,
    show.id
  );

  result.reviewsFound = merged;
  result.newReviews = added;
  result.updatedReviews = updated;

  // Validate
  const validation = validateReviews(merged);
  if (!validation.valid) {
    console.log(`\nValidation errors:`);
    for (const error of validation.errors) {
      console.log(`  - ${error}`);
      result.errors.push(`Validation: ${error}`);
    }
  }

  // Summary
  console.log(`\nResult Summary:`);
  console.log(`  - New reviews: ${added.length}`);
  console.log(`  - Updated reviews: ${updated.length}`);
  console.log(`  - Unchanged reviews: ${unchanged.length}`);
  console.log(`  - Total for show: ${merged.length}`);

  if (added.length > 0) {
    console.log(`\nNew reviews:`);
    for (const review of added) {
      console.log(`  + ${review.outlet} (${review.criticName || 'unknown critic'}): ${review.assignedScore}`);
    }
  }

  if (updated.length > 0) {
    console.log(`\nUpdated reviews:`);
    for (const review of updated) {
      console.log(`  ~ ${review.outlet} (${review.criticName || 'unknown critic'}): ${review.assignedScore}`);
    }
  }

  return result;
}

// ===========================================
// MANUAL DATA ENTRY MODE
// ===========================================

/**
 * Process manual review entries from a JSON file
 * This is useful for adding reviews that can't be automatically fetched
 */
function processManualEntries(
  manualFile: string,
  existingReviews: NormalizedReview[]
): NormalizedReview[] {
  if (!fs.existsSync(manualFile)) {
    return [];
  }

  const manualData = JSON.parse(fs.readFileSync(manualFile, 'utf-8'));
  const newReviews: NormalizedReview[] = [];

  for (const entry of manualData.reviews || []) {
    const raw = createManualReview({
      outletName: entry.outlet,
      criticName: entry.criticName,
      url: entry.url,
      publishDate: entry.publishDate,
      rating: entry.rating || entry.originalRating,
      ratingType: entry.ratingType,
      excerpt: entry.pullQuote || entry.excerpt,
      designation: entry.designation,
    });

    const normalized = normalizeReview(raw, entry.showId);
    if (normalized) {
      // If assignedScore is explicitly provided, use it
      if (entry.assignedScore !== undefined) {
        normalized.assignedScore = entry.assignedScore;
        normalized.bucket = scoreToBucket(entry.assignedScore);
        normalized.thumb = scoreToThumb(entry.assignedScore);
      }
      newReviews.push(normalized);
    }
  }

  return newReviews;
}

// ===========================================
// REPORT GENERATION
// ===========================================

function generateReport(reviews: NormalizedReview[], shows: ShowData[]): void {
  console.log('\n' + '='.repeat(60));
  console.log('BROADWAY CRITIC REVIEWS - DATA REPORT');
  console.log('='.repeat(60));
  console.log(`Generated: ${new Date().toISOString()}`);
  console.log('');

  // Per-show breakdown
  const openShows = shows.filter(s => s.status === 'open');

  console.log(`Open Shows: ${openShows.length}`);
  console.log('');

  for (const show of openShows) {
    const showReviews = reviews.filter(r => r.showId === show.id);

    // Count by tier
    const tier1Count = showReviews.filter(r => {
      const config = findOutletConfig(r.outlet);
      return config?.tier === 1;
    }).length;
    const tier2Count = showReviews.filter(r => {
      const config = findOutletConfig(r.outlet);
      return config?.tier === 2;
    }).length;
    const tier3Count = showReviews.filter(r => {
      const config = findOutletConfig(r.outlet);
      return config?.tier === 3 || !config;
    }).length;

    // Calculate average score
    const avgScore = showReviews.length > 0
      ? Math.round(showReviews.reduce((sum, r) => sum + r.assignedScore, 0) / showReviews.length)
      : 0;

    // Missing key outlets
    const keyOutlets = ['NYT', 'VARIETY', 'THR', 'VULT', 'TIMEOUTNY', 'GUARDIAN'];
    const reviewedOutletIds = showReviews.map(r => r.outletId);
    const missingKey = keyOutlets.filter(id => !reviewedOutletIds.includes(id));

    console.log(`${show.title}`);
    console.log(`  Reviews: ${showReviews.length} (T1: ${tier1Count}, T2: ${tier2Count}, T3: ${tier3Count})`);
    console.log(`  Avg Score: ${avgScore || 'N/A'}`);
    if (missingKey.length > 0 && missingKey.length < 6) {
      console.log(`  Missing: ${missingKey.join(', ')}`);
    }
    console.log('');
  }

  // Outlet coverage
  console.log('=' .repeat(60));
  console.log('OUTLET COVERAGE');
  console.log('='.repeat(60));

  const outletCounts = new Map<string, number>();
  for (const review of reviews) {
    const count = outletCounts.get(review.outlet) || 0;
    outletCounts.set(review.outlet, count + 1);
  }

  const sortedOutlets = Array.from(outletCounts.entries())
    .sort((a, b) => b[1] - a[1]);

  for (const [outlet, count] of sortedOutlets.slice(0, 15)) {
    const config = findOutletConfig(outlet);
    const tier = config ? `T${config.tier}` : 'T?';
    console.log(`  ${outlet} (${tier}): ${count} reviews`);
  }
}

// ===========================================
// CLI ARGUMENT PARSING
// ===========================================

interface CliArgs {
  show?: string;
  all?: boolean;
  report?: boolean;
  sources?: string[];
  verbose?: boolean;
  dryRun?: boolean;
  manualFile?: string;
  comprehensive?: boolean;
  search?: boolean; // Use search API instead of direct scraping
  searchProvider?: 'serpapi' | 'brave';
  help?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--show' || arg === '-s') {
      args.show = argv[++i];
    } else if (arg === '--all' || arg === '-a') {
      args.all = true;
    } else if (arg === '--report' || arg === '-r') {
      args.report = true;
    } else if (arg === '--sources') {
      args.sources = argv[++i].split(',');
    } else if (arg === '--verbose' || arg === '-v') {
      args.verbose = true;
    } else if (arg === '--dry-run' || arg === '-n') {
      args.dryRun = true;
    } else if (arg === '--manual') {
      args.manualFile = argv[++i];
    } else if (arg === '--comprehensive' || arg === '-c') {
      args.comprehensive = true;
    } else if (arg === '--search') {
      args.search = true;
    } else if (arg === '--search-provider') {
      args.searchProvider = argv[++i] as 'serpapi' | 'brave';
    }
  }

  return args;
}

function printHelp(): void {
  const outletCount = getSearchableOutlets().length;
  console.log(`
Broadway Critic Reviews Agent

Usage:
  npx ts-node scripts/critic-reviews-agent/index.ts [options]

Options:
  --show, -s <id>      Process a specific show by ID
  --all, -a            Process all open shows
  --report, -r         Generate a report of existing data
  --sources <list>     Comma-separated sources (broadwayworld,didtheylikeit,showscore)
  --comprehensive, -c  Search ALL ${outletCount} configured outlets + web search
  --search             Use search API instead of direct scraping (more reliable)
  --search-provider    Search API provider: serpapi (default) or brave
  --manual <file>      Process manual entries from a JSON file
  --verbose, -v        Enable verbose output
  --dry-run, -n        Don't write changes to files
  --help, -h           Show this help message

Environment Variables:
  SERPAPI_KEY          API key for SerpAPI (serpapi.com) - Google search results
  BRAVE_API_KEY        API key for Brave Search API (brave.com/search/api)

Examples:
  # Fetch reviews using search API (recommended)
  SERPAPI_KEY=xxx npx ts-node scripts/critic-reviews-agent/index.ts --show bug-2025 --search

  # Fetch reviews for a show (direct scraping - may be blocked)
  npx ts-node scripts/critic-reviews-agent/index.ts --show bug-2025

  # Comprehensive search across all outlets
  npx ts-node scripts/critic-reviews-agent/index.ts --show bug-2025 --comprehensive --verbose

  # Fetch from specific sources only
  npx ts-node scripts/critic-reviews-agent/index.ts --show two-strangers-bway-2025 --sources broadwayworld

  # Process all shows with search API
  SERPAPI_KEY=xxx npx ts-node scripts/critic-reviews-agent/index.ts --all --search --verbose

  # Generate report only
  npx ts-node scripts/critic-reviews-agent/index.ts --report

  # Add manual entries
  npx ts-node scripts/critic-reviews-agent/index.ts --manual data/manual-reviews.json
`);
}

// ===========================================
// MAIN ENTRY POINT
// ===========================================

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  // Ensure agent output directory exists
  if (!fs.existsSync(AGENT_OUTPUT_DIR)) {
    fs.mkdirSync(AGENT_OUTPUT_DIR, { recursive: true });
  }

  // Load data
  const shows = loadShows();
  const reviewsData = loadReviews();
  let reviews = reviewsData.reviews;

  // Report mode
  if (args.report) {
    generateReport(reviews, shows);
    process.exit(0);
  }

  // Process manual entries if provided
  if (args.manualFile) {
    console.log(`Processing manual entries from: ${args.manualFile}`);
    const manualReviews = processManualEntries(args.manualFile, reviews);
    console.log(`Found ${manualReviews.length} manual entries`);

    if (manualReviews.length > 0 && !args.dryRun) {
      // Merge with existing
      const { deduplicated } = deduplicateReviews([...reviews, ...manualReviews]);
      reviewsData.reviews = deduplicated;
      saveReviews(reviewsData);
      console.log('Manual entries merged and saved.');
    }
  }

  // Determine which shows to process
  let showsToProcess: ShowData[] = [];

  if (args.show) {
    const show = shows.find(s => s.id === args.show || s.slug === args.show);
    if (!show) {
      console.error(`Show not found: ${args.show}`);
      console.log('Available shows:');
      for (const s of shows) {
        console.log(`  - ${s.id} (${s.title})`);
      }
      process.exit(1);
    }
    showsToProcess = [show];
  } else if (args.all) {
    showsToProcess = shows.filter(s => s.status === 'open');
  } else if (!args.manualFile) {
    printHelp();
    process.exit(0);
  }

  // Build search API config if search mode is enabled
  let searchApiConfig: SearchAPIConfig | undefined;
  if (args.search) {
    const provider = args.searchProvider || 'serpapi';
    let apiKey: string | undefined;

    if (provider === 'serpapi') {
      apiKey = process.env.SERPAPI_KEY;
      if (!apiKey) {
        console.error('Error: SERPAPI_KEY environment variable is required for search mode.');
        console.log('Get an API key at: https://serpapi.com');
        console.log('Usage: SERPAPI_KEY=xxx npm run reviews:fetch -- --show bug-2025 --search');
        process.exit(1);
      }
    } else if (provider === 'brave') {
      apiKey = process.env.BRAVE_API_KEY;
      if (!apiKey) {
        console.error('Error: BRAVE_API_KEY environment variable is required for Brave search.');
        console.log('Get an API key at: https://brave.com/search/api');
        console.log('Usage: BRAVE_API_KEY=xxx npm run reviews:fetch -- --show bug-2025 --search --search-provider brave');
        process.exit(1);
      }
    }

    searchApiConfig = { provider, apiKey };
    console.log(`\nSearch mode enabled (provider: ${provider})`);
  }

  // Process shows
  const allResults: AgentResult[] = [];

  for (const show of showsToProcess) {
    try {
      const result = await processShow(show, reviews, {
        sources: args.sources,
        verbose: args.verbose,
        dryRun: args.dryRun,
        comprehensive: args.comprehensive,
        search: args.search,
        searchApiConfig,
      });
      allResults.push(result);

      // Update reviews with new data (if not dry run)
      if (!args.dryRun && (result.newReviews.length > 0 || result.updatedReviews.length > 0)) {
        // Remove existing reviews for this show
        reviews = reviews.filter(r => r.showId !== show.id);
        // Add merged reviews
        reviews.push(...result.reviewsFound);
      }
    } catch (error) {
      console.error(`\nError processing ${show.title}: ${error}`);
      allResults.push({
        showId: show.id,
        showTitle: show.title,
        reviewsFound: [],
        newReviews: [],
        updatedReviews: [],
        skippedDuplicates: 0,
        errors: [(error as Error).message],
        sources: args.sources || [],
      });
    }
  }

  // Save results
  if (!args.dryRun && showsToProcess.length > 0) {
    reviewsData.reviews = reviews;
    saveReviews(reviewsData);
    console.log(`\nSaved updated reviews to ${REVIEWS_FILE}`);
  }

  // Save agent run log
  const runLog = {
    timestamp: new Date().toISOString(),
    args: args,
    results: allResults,
  };
  const logFile = path.join(AGENT_OUTPUT_DIR, `run-${Date.now()}.json`);
  fs.writeFileSync(logFile, JSON.stringify(runLog, null, 2));
  console.log(`\nRun log saved to ${logFile}`);

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('AGENT RUN COMPLETE');
  console.log('='.repeat(60));

  const totalNew = allResults.reduce((sum, r) => sum + r.newReviews.length, 0);
  const totalUpdated = allResults.reduce((sum, r) => sum + r.updatedReviews.length, 0);
  const totalErrors = allResults.reduce((sum, r) => sum + r.errors.length, 0);

  console.log(`Shows processed: ${allResults.length}`);
  console.log(`New reviews: ${totalNew}`);
  console.log(`Updated reviews: ${totalUpdated}`);
  console.log(`Errors: ${totalErrors}`);

  if (args.dryRun) {
    console.log('\n(Dry run - no changes written)');
  }
}

// Run
main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
