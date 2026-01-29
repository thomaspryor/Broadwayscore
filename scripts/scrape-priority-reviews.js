#!/usr/bin/env node

/**
 * Scrape Priority Reviews
 *
 * Identifies excerpt-only reviews that should be re-scraped and prioritizes them
 * based on outlet tier, paywall status, and previous scraping attempts.
 *
 * Outputs:
 * - /tmp/scraping-priority.json - Prioritized list of reviews to scrape
 * - Summary to console with breakdown by outlet and estimated success rates
 *
 * Usage:
 *   node scripts/scrape-priority-reviews.js
 *   node scripts/scrape-priority-reviews.js --verbose
 *   node scripts/scrape-priority-reviews.js --tier=1          # Only Tier 1 outlets
 *   node scripts/scrape-priority-reviews.js --method=free     # Only free outlets
 *   node scripts/scrape-priority-reviews.js --limit=100       # Limit output
 */

const fs = require('fs');
const path = require('path');

// ============================================
// CONFIGURATION
// ============================================

// Parse command line arguments
function parseArgs() {
  const args = {
    verbose: false,
    tierFilter: null,
    paywallFilter: null,
    limit: null,
  };

  for (const arg of process.argv.slice(2)) {
    if (arg === '--verbose' || arg === '-v') {
      args.verbose = true;
    } else if (arg.startsWith('--tier=')) {
      args.tierFilter = parseInt(arg.split('=')[1]);
    } else if (arg.startsWith('--method=') || arg.startsWith('--paywall=')) {
      args.paywallFilter = arg.split('=')[1];
    } else if (arg.startsWith('--limit=')) {
      args.limit = parseInt(arg.split('=')[1]);
    }
  }

  return args;
}

const ARGS = parseArgs();

const CONFIG = {
  reviewTextsDir: path.join(__dirname, '..', 'data', 'review-texts'),
  failedFetchesFile: path.join(__dirname, '..', 'data', 'review-texts', 'failed-fetches.json'),
  outputFile: '/tmp/scraping-priority.json',
  verbose: ARGS.verbose,
  tierFilter: ARGS.tierFilter,
  paywallFilter: ARGS.paywallFilter,
  limit: ARGS.limit,
};

// ============================================
// OUTLET TIERS (from scoring.ts)
// ============================================

// Tier 1: Major national publications & top culture sites
const TIER_1_OUTLETS = new Set([
  'nytimes', 'nyt', 'new york times', 'the new york times',
  'variety',
  'vulture', 'ny mag', 'new york magazine',
  'hollywood-reporter', 'thr', 'hollywoodreporter', 'the hollywood reporter',
  'deadline',
  'guardian', 'the guardian',
  'newyorker', 'the new yorker', 'new yorker',
  'time', 'time magazine',
  'washpost', 'washington post', 'the washington post', 'wapo',
  'wsj', 'wall street journal', 'the wall street journal',
  'latimes', 'los angeles times', 'la times',
  'ap', 'associated press',
  'timeout', 'time out', 'time out new york',
  'broadwaynews', 'broadway news',
]);

// Tier 2: Regional papers, trades, theatre-specific outlets
const TIER_2_OUTLETS = new Set([
  'theatermania', 'theatremania',
  'nypost', 'new york post', 'ny post',
  'nydailynews', 'new york daily news', 'ny daily news', 'nydn',
  'ew', 'entertainment weekly',
  'usatoday', 'usa today',
  'observer', 'the observer', 'ny observer',
  'indiewire', 'indie wire',
  'thewrap', 'the wrap', 'wrap',
  'dailybeast', 'the daily beast', 'daily beast', 'tdb',
  'telegraph', 'the telegraph',
  'broadwayworld', 'bww', 'broadway world',
  'chicagotribune', 'chicago tribune',
  'newsday',
  'rollingstone', 'rolling stone',
  'bloomberg',
  'vox',
  'slate',
  'people',
  'billboard',
  'huffpost', 'huffington post',
  'backstage',
  'nysr', 'new york stage review',
  'nytg', 'new york theatre guide',
  'nyt-theater', 'new york theater',
  'theatrely', 'thly',
  'slantmagazine', 'slant magazine', 'slant',
]);

// ============================================
// PAYWALL STATUS
// ============================================

// FREE: No paywall, should scrape directly
const FREE_OUTLETS = new Set([
  'stageandcinema', 'stage and cinema',
  'theatrely', 'thly',
  'cititour',
  'nyt-theater', 'new york theater',
  'culturesauce', 'culture sauce',
  'frontmezzjunkies', 'front mezz junkies',
  'talkinbroadway', "talkin' broadway",
  'broadwayworld', 'bww', 'broadway world',
  'nysr', 'new york stage review',
  'nytg', 'new york theatre guide',
  'amny', 'amnewyork',
  'playbill',
  'dctheatrescene', 'dc theatre scene',
  'artsfuse', 'the arts fuse',
  'towleroad',
  'queerty',
  'medium',
  'buzzfeed',
  'huffpost', 'huffington post',
]);

// METERED: Some articles free, some paywalled - try Archive.org first
const METERED_OUTLETS = new Set([
  'variety',
  'hollywood-reporter', 'thr', 'hollywoodreporter', 'the hollywood reporter',
  'deadline',
  'indiewire', 'indie wire',
  'thewrap', 'the wrap', 'wrap',
  'billboard',
  'rollingstone', 'rolling stone',
  'observer', 'the observer',
  'dailybeast', 'the daily beast', 'daily beast', 'tdb',
  'chicagotribune', 'chicago tribune',
  'latimes', 'los angeles times', 'la times',
  'newsday',
  'ap', 'associated press',
  'bloomberg',
  'vox',
  'slate',
  'people',
]);

// PAYWALLED with credentials (user has subscriptions)
const PAYWALLED_WITH_CREDENTIALS = new Set([
  'nytimes', 'nyt', 'new york times', 'the new york times',
  'vulture', 'ny mag', 'new york magazine',
  'newyorker', 'the new yorker', 'new yorker',
  'washpost', 'washington post', 'the washington post', 'wapo',
  'wsj', 'wall street journal', 'the wall street journal',
]);

// PAYWALLED without credentials - Archive.org only
const PAYWALLED_NO_CREDENTIALS = new Set([
  'ew', 'entertainment weekly',
  'nypost', 'new york post', 'ny post',
  'guardian', 'the guardian',
  'timeout', 'time out', 'time out new york',
  'time', 'time magazine',
  'theatermania', 'theatremania',
  'telegraph', 'the telegraph',
  'broadwaynews', 'broadway news',
  'usatoday', 'usa today',
  'backstage',
  'nydailynews', 'new york daily news', 'ny daily news', 'nydn',
  'slantmagazine', 'slant magazine', 'slant',
]);

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Normalize outlet name for comparison
 */
function normalizeOutletName(name) {
  if (!name) return '';
  return name.toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/['']/g, '')
    .replace(/\s+/g, '-')
    .trim();
}

/**
 * Determine outlet tier (1, 2, or 3)
 */
function getOutletTier(outlet) {
  const normalized = normalizeOutletName(outlet);
  const outletLower = outlet?.toLowerCase() || '';

  // Check Tier 1
  for (const t1 of TIER_1_OUTLETS) {
    if (normalized === t1 || outletLower.includes(t1) || t1.includes(normalized)) {
      return 1;
    }
  }

  // Check Tier 2
  for (const t2 of TIER_2_OUTLETS) {
    if (normalized === t2 || outletLower.includes(t2) || t2.includes(normalized)) {
      return 2;
    }
  }

  // Default to Tier 3
  return 3;
}

/**
 * Determine paywall status
 */
function getPaywallStatus(outlet) {
  const normalized = normalizeOutletName(outlet);
  const outletLower = outlet?.toLowerCase() || '';

  // Check free
  for (const f of FREE_OUTLETS) {
    if (normalized === f || outletLower.includes(f) || f.includes(normalized)) {
      return 'free';
    }
  }

  // Check metered
  for (const m of METERED_OUTLETS) {
    if (normalized === m || outletLower.includes(m) || m.includes(normalized)) {
      return 'metered';
    }
  }

  // Check paywalled with credentials
  for (const p of PAYWALLED_WITH_CREDENTIALS) {
    if (normalized === p || outletLower.includes(p) || p.includes(normalized)) {
      return 'paywalled';
    }
  }

  // Check paywalled without credentials
  for (const p of PAYWALLED_NO_CREDENTIALS) {
    if (normalized === p || outletLower.includes(p) || p.includes(normalized)) {
      return 'paywalled';
    }
  }

  // Unknown - assume free
  return 'free';
}

/**
 * Check if user has credentials for outlet
 */
function hasCredentials(outlet) {
  const normalized = normalizeOutletName(outlet);
  const outletLower = outlet?.toLowerCase() || '';

  for (const p of PAYWALLED_WITH_CREDENTIALS) {
    if (normalized === p || outletLower.includes(p) || p.includes(normalized)) {
      return true;
    }
  }
  return false;
}

/**
 * Determine recommended scraping method
 */
function getRecommendedMethod(paywallStatus, hasCredentials, methodsTried) {
  const triedSet = new Set(methodsTried.map(m => m.toLowerCase()));

  if (paywallStatus === 'free') {
    // FREE: Playwright -> ScrapingBee -> BrightData -> Archive.org
    if (!triedSet.has('playwright') && !triedSet.has('playwright-stealth')) {
      return 'playwright';
    }
    if (!triedSet.has('scrapingbee')) {
      return 'scrapingbee';
    }
    if (!triedSet.has('brightdata')) {
      return 'brightdata';
    }
    if (!triedSet.has('archive.org') && !triedSet.has('archive')) {
      return 'archive.org';
    }
    return 'all-failed';
  }

  if (paywallStatus === 'metered') {
    // METERED: Archive.org first -> then direct scraping
    if (!triedSet.has('archive.org') && !triedSet.has('archive')) {
      return 'archive.org';
    }
    if (!triedSet.has('playwright') && !triedSet.has('playwright-stealth')) {
      return 'playwright';
    }
    if (!triedSet.has('scrapingbee')) {
      return 'scrapingbee';
    }
    if (!triedSet.has('brightdata')) {
      return 'brightdata';
    }
    return 'all-failed';
  }

  if (paywallStatus === 'paywalled') {
    // PAYWALLED: Archive.org first
    if (!triedSet.has('archive.org') && !triedSet.has('archive')) {
      return 'archive.org';
    }
    if (hasCredentials) {
      // With credentials: Try authenticated Playwright
      if (!triedSet.has('playwright-auth') && !triedSet.has('authenticated-playwright')) {
        return 'authenticated-playwright';
      }
    }
    return 'archive-only';
  }

  return 'unknown';
}

/**
 * Calculate priority score (1 = highest, 5 = lowest)
 */
function calculatePriority(tier, paywallStatus, hasCredentials, methodsTried) {
  let priority = 3; // Default

  // Tier adjustment: Tier 1 = -1, Tier 2 = 0, Tier 3 = +1
  priority += (tier - 2);

  // Paywall adjustment
  if (paywallStatus === 'free') {
    priority -= 1;
  } else if (paywallStatus === 'paywalled' && !hasCredentials) {
    priority += 1;
  }

  // Never tried adjustment
  if (methodsTried.length === 0) {
    priority -= 1;
  }

  // Clamp to 1-5
  return Math.max(1, Math.min(5, priority));
}

/**
 * Load failed fetches data
 */
function loadFailedFetches() {
  if (!fs.existsSync(CONFIG.failedFetchesFile)) {
    return {};
  }

  try {
    const data = JSON.parse(fs.readFileSync(CONFIG.failedFetchesFile, 'utf8'));
    // Index by filePath for quick lookup
    const index = {};
    for (const entry of data) {
      index[entry.filePath] = entry;
    }
    return index;
  } catch (e) {
    console.error('Warning: Could not parse failed-fetches.json:', e.message);
    return {};
  }
}

/**
 * Extract methods already tried from review data and failed-fetches
 */
function getMethodsTried(reviewData, failedEntry) {
  const methods = new Set();

  // From review data
  if (reviewData.textFetchMethod) {
    methods.add(reviewData.textFetchMethod);
  }
  if (reviewData.sourceMethod) {
    methods.add(reviewData.sourceMethod);
  }

  // From failed-fetches
  if (failedEntry && failedEntry.errors) {
    for (const err of failedEntry.errors) {
      if (err.method) {
        methods.add(err.method);
      }
    }
  }

  return Array.from(methods);
}

/**
 * Check if review is excerpt-only (needs full text)
 */
function isExcerptOnly(reviewData) {
  // Has fullText that's sufficient
  if (reviewData.fullText && reviewData.fullText.length > 1000) {
    return false;
  }

  // Check textQuality
  if (reviewData.textQuality === 'full') {
    return false;
  }

  // Has URL to try
  if (!reviewData.url) {
    return false;
  }

  // Has at least some excerpt content
  const hasContent = reviewData.dtliExcerpt ||
                     reviewData.bwwExcerpt ||
                     reviewData.showScoreExcerpt ||
                     (reviewData.fullText && reviewData.fullText.length > 50);

  return hasContent;
}

/**
 * Get estimated success rate for outlet type
 */
function getEstimatedSuccessRate(paywallStatus, hasCredentials) {
  if (paywallStatus === 'free') {
    return 0.75; // 75% success rate for free outlets
  }
  if (paywallStatus === 'metered') {
    return 0.50; // 50% success rate (Archive.org may have it)
  }
  if (paywallStatus === 'paywalled' && hasCredentials) {
    return 0.60; // 60% with credentials
  }
  if (paywallStatus === 'paywalled' && !hasCredentials) {
    return 0.25; // 25% Archive.org only
  }
  return 0.40; // Unknown
}

// ============================================
// MAIN LOGIC
// ============================================

async function main() {
  console.log('=== Scrape Priority Reviews Analysis ===\n');

  // Load failed fetches
  const failedFetches = loadFailedFetches();
  console.log(`Loaded ${Object.keys(failedFetches).length} failed fetch records\n`);

  // Scan all review files
  const priorityList = [];
  const outletStats = {};

  if (!fs.existsSync(CONFIG.reviewTextsDir)) {
    console.error('Review texts directory not found:', CONFIG.reviewTextsDir);
    process.exit(1);
  }

  const shows = fs.readdirSync(CONFIG.reviewTextsDir)
    .filter(f => {
      const p = path.join(CONFIG.reviewTextsDir, f);
      return fs.statSync(p).isDirectory();
    });

  console.log(`Scanning ${shows.length} shows...\n`);

  let totalReviews = 0;
  let excerptOnlyReviews = 0;

  for (const showId of shows) {
    const showDir = path.join(CONFIG.reviewTextsDir, showId);
    const files = fs.readdirSync(showDir)
      .filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');

    for (const file of files) {
      totalReviews++;
      const filePath = path.join(showDir, file);
      const relativePath = path.relative(path.join(__dirname, '..'), filePath);

      try {
        const reviewData = JSON.parse(fs.readFileSync(filePath, 'utf8'));

        // Skip if not excerpt-only
        if (!isExcerptOnly(reviewData)) {
          continue;
        }

        excerptOnlyReviews++;

        const outlet = reviewData.outlet || reviewData.outletId || 'unknown';
        const tier = getOutletTier(outlet);
        const paywallStatus = getPaywallStatus(outlet);
        const credentials = hasCredentials(outlet);
        const failedEntry = failedFetches[relativePath] || failedFetches[filePath];
        const methodsTried = getMethodsTried(reviewData, failedEntry);
        const recommendedMethod = getRecommendedMethod(paywallStatus, credentials, methodsTried);
        const priority = calculatePriority(tier, paywallStatus, credentials, methodsTried);

        // Track outlet stats
        const outletKey = normalizeOutletName(outlet) || 'unknown';
        if (!outletStats[outletKey]) {
          outletStats[outletKey] = {
            name: outlet,
            count: 0,
            tier,
            paywallStatus,
            hasCredentials: credentials,
          };
        }
        outletStats[outletKey].count++;

        priorityList.push({
          reviewPath: relativePath,
          url: reviewData.url,
          outlet: outlet,
          outletId: reviewData.outletId,
          critic: reviewData.criticName,
          showId: reviewData.showId || showId,
          tier,
          paywallStatus,
          hasCredentials: credentials,
          methodsAlreadyTried: methodsTried,
          failedAttempts: failedEntry?.attempts || 0,
          recommendedMethod,
          priority,
        });

      } catch (e) {
        if (CONFIG.verbose) {
          console.error(`Error reading ${filePath}:`, e.message);
        }
      }
    }
  }

  // Sort by priority (1 = highest first)
  priorityList.sort((a, b) => {
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }
    // Secondary sort by tier
    if (a.tier !== b.tier) {
      return a.tier - b.tier;
    }
    // Tertiary sort by failed attempts (fewer = higher priority)
    return a.failedAttempts - b.failedAttempts;
  });

  // Apply filters if specified
  let filteredList = priorityList;

  if (CONFIG.tierFilter) {
    filteredList = filteredList.filter(item => item.tier === CONFIG.tierFilter);
    console.log(`Filtered to Tier ${CONFIG.tierFilter}: ${filteredList.length} reviews\n`);
  }

  if (CONFIG.paywallFilter) {
    filteredList = filteredList.filter(item => item.paywallStatus === CONFIG.paywallFilter);
    console.log(`Filtered to ${CONFIG.paywallFilter} outlets: ${filteredList.length} reviews\n`);
  }

  if (CONFIG.limit) {
    filteredList = filteredList.slice(0, CONFIG.limit);
    console.log(`Limited to ${CONFIG.limit} reviews\n`);
  }

  // Calculate summary stats (on filtered list)
  const priorityCounts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  const tierCounts = { 1: 0, 2: 0, 3: 0 };
  const paywallCounts = { free: 0, metered: 0, paywalled: 0 };
  let totalEstimatedSuccess = 0;

  for (const item of filteredList) {
    priorityCounts[item.priority]++;
    tierCounts[item.tier]++;
    paywallCounts[item.paywallStatus]++;
    totalEstimatedSuccess += getEstimatedSuccessRate(item.paywallStatus, item.hasCredentials);
  }

  // Write output file
  const output = {
    generatedAt: new Date().toISOString(),
    filters: {
      tier: CONFIG.tierFilter,
      paywall: CONFIG.paywallFilter,
      limit: CONFIG.limit,
    },
    summary: {
      totalReviews,
      excerptOnlyReviews,
      filteredCount: filteredList.length,
      byPriority: priorityCounts,
      byTier: tierCounts,
      byPaywallStatus: paywallCounts,
      estimatedSuccessRate: filteredList.length > 0
        ? (totalEstimatedSuccess / filteredList.length * 100).toFixed(1) + '%'
        : '0%',
    },
    reviews: filteredList,
  };

  fs.writeFileSync(CONFIG.outputFile, JSON.stringify(output, null, 2));
  console.log(`\nOutput written to: ${CONFIG.outputFile}\n`);

  // Print summary
  console.log('=== SUMMARY ===\n');
  console.log(`Total reviews scanned: ${totalReviews}`);
  console.log(`Excerpt-only reviews: ${excerptOnlyReviews} (${(excerptOnlyReviews/totalReviews*100).toFixed(1)}%)`);
  if (filteredList.length !== excerptOnlyReviews) {
    console.log(`After filters: ${filteredList.length} reviews`);
  }
  console.log('');

  console.log('--- By Priority ---');
  console.log(`  Priority 1 (Highest): ${priorityCounts[1]}`);
  console.log(`  Priority 2:           ${priorityCounts[2]}`);
  console.log(`  Priority 3:           ${priorityCounts[3]}`);
  console.log(`  Priority 4:           ${priorityCounts[4]}`);
  console.log(`  Priority 5 (Lowest):  ${priorityCounts[5]}`);
  console.log('');

  console.log('--- By Outlet Tier ---');
  console.log(`  Tier 1 (Major):       ${tierCounts[1]}`);
  console.log(`  Tier 2 (Regional):    ${tierCounts[2]}`);
  console.log(`  Tier 3 (Niche):       ${tierCounts[3]}`);
  console.log('');

  console.log('--- By Paywall Status ---');
  console.log(`  Free:                 ${paywallCounts.free}`);
  console.log(`  Metered:              ${paywallCounts.metered}`);
  console.log(`  Paywalled:            ${paywallCounts.paywalled}`);
  console.log('');

  console.log('--- Estimated Success Rate ---');
  console.log(`  Overall: ${output.summary.estimatedSuccessRate}`);
  console.log('');

  // Top outlets breakdown
  console.log('--- Top 15 Outlets by Count ---');
  const sortedOutlets = Object.values(outletStats)
    .sort((a, b) => b.count - a.count)
    .slice(0, 15);

  for (const outlet of sortedOutlets) {
    const tierLabel = `T${outlet.tier}`;
    const paywallLabel = outlet.paywallStatus.charAt(0).toUpperCase() + outlet.paywallStatus.slice(1);
    const credLabel = outlet.hasCredentials ? '(creds)' : '';
    console.log(`  ${outlet.name.padEnd(30)} ${String(outlet.count).padStart(3)} reviews | ${tierLabel} | ${paywallLabel} ${credLabel}`);
  }
  console.log('');

  // Method recommendations
  console.log('--- Recommended Methods Summary ---');
  const methodCounts = {};
  for (const item of filteredList) {
    methodCounts[item.recommendedMethod] = (methodCounts[item.recommendedMethod] || 0) + 1;
  }
  for (const [method, count] of Object.entries(methodCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${method.padEnd(25)} ${count}`);
  }
  console.log('');

  // Sample high-priority items
  console.log('--- Sample Priority 1 Reviews ---');
  const p1Items = filteredList.filter(i => i.priority === 1).slice(0, 10);
  for (const item of p1Items) {
    console.log(`  ${item.outlet} - ${item.showId}`);
    console.log(`    URL: ${item.url?.substring(0, 60)}...`);
    console.log(`    Method: ${item.recommendedMethod}`);
  }

  console.log('\n=== Analysis Complete ===');
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
