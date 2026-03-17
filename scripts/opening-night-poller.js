#!/usr/bin/env node
/**
 * Opening Night Review Poller
 *
 * Discovers reviews faster than SERP using 4 layers:
 *   1. Aggregators (BWW RR, Show Score, DTLI) — fastest, update within minutes
 *   2. RSS feeds (Variety, NYT, Guardian) — free, no API cost
 *   3. Direct site search (outlet search endpoints) — instant on publish
 *   4. SERP backup (Google via ScrapingBee/BrightData) — catches the rest
 *
 * Each poll cycle discovers new URLs, creates review files, and reports progress.
 * Designed to be called repeatedly by a CI workflow every 15 min on opening night.
 *
 * Usage:
 *   node scripts/opening-night-poller.js --show=show-id-2026
 *   node scripts/opening-night-poller.js --show=show-id-2026 --dry-run
 *   node scripts/opening-night-poller.js --show=show-id-2026 --skip-serp
 *   node scripts/opening-night-poller.js --show=show-id-2026 --skip-site-search
 *
 * Environment Variables:
 *   SCRAPINGBEE_API_KEY - For SERP + JS-rendered site search
 *   BRIGHTDATA_TOKEN    - SERP fallback
 */

const fs = require('fs');
const path = require('path');

// Reuse existing infrastructure
const {
  searchDTLI,
  searchShowScore,
  searchBWWRoundup,
  extractDTLIReviews,
  extractShowScoreReviews,
  extractBWWRoundupReviews,
  createReviewFile,
  loadShowData,
  gatherReviewsForShow,
} = require('./gather-reviews');

const { checkRSSFeeds } = require('./lib/rss-discovery');
const { searchOutletSites, SITE_SEARCH_ENDPOINTS } = require('./lib/site-search-discovery');
const { discoverCorrectUrl, OUTLET_DOMAINS } = require('./lib/url-discovery');
const { validatePageMatchesShow } = require('./lib/page-validator');
const { isLondonMarket } = require('./lib/venue-classification');

// Paths
const DATA_DIR = path.join(__dirname, '..', 'data');
const REVIEW_TEXTS_DIR = path.join(DATA_DIR, 'review-texts');
const REVIEWS_PATH = path.join(DATA_DIR, 'reviews.json');
const SHOWS_PATH = path.join(DATA_DIR, 'shows.json');
const OUTLET_REGISTRY_PATH = path.join(DATA_DIR, 'outlet-registry.json');

// CLI args
const SHOW_ID = (process.argv.find(a => a.startsWith('--show=')) || '').replace('--show=', '');
const DRY_RUN = process.argv.includes('--dry-run');
const SKIP_SERP = process.argv.includes('--skip-serp');
const SKIP_SITE_SEARCH = process.argv.includes('--skip-site-search');
const VERBOSE = process.argv.includes('--verbose') || true; // Always verbose for CI logs

// Readiness thresholds — market-aware (must match send-opening-night-broadcast.js)
function getThresholds(market) {
  const isWE = market === 'west-end' || market === 'off-west-end';
  return {
    MIN_REVIEWS: isWE ? 8 : 12,
    MIN_T1_REVIEWS: 3,
    MIN_T2_REVIEWS: isWE ? 2 : 3,
    MIN_HIGH_CONFIDENCE: isWE ? 6 : 8,
  };
}

/**
 * Get all known URLs for a show (from existing review-text files on disk)
 */
function getKnownUrls(showId) {
  const urls = new Set();
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  if (!fs.existsSync(showDir)) return urls;

  for (const file of fs.readdirSync(showDir)) {
    if (!file.endsWith('.json') || file === 'failed-fetches.json') continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf8'));
      if (data.url) urls.add(data.url);
      if (data.reviewUrl) urls.add(data.reviewUrl);
    } catch {}
  }
  return urls;
}

/**
 * Get found outlet IDs for a show (from existing review-text files)
 */
function getFoundOutletIds(showId) {
  const outletIds = new Set();
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  if (!fs.existsSync(showDir)) return outletIds;

  for (const file of fs.readdirSync(showDir)) {
    if (!file.endsWith('.json') || file === 'failed-fetches.json') continue;
    try {
      const data = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf8'));
      if (data.outletId) outletIds.add(data.outletId.toLowerCase());
    } catch {}
  }
  return outletIds;
}

/**
 * Get T1/T2 outlets that haven't been found yet for a show
 */
function getMissingT1T2Outlets(showId, market) {
  const registry = JSON.parse(fs.readFileSync(OUTLET_REGISTRY_PATH, 'utf8'));
  const outlets = registry.outlets || registry;
  const foundIds = getFoundOutletIds(showId);

  const missing = [];
  for (const [outletId, outlet] of Object.entries(outlets)) {
    if (outlet.tier > 2) continue;
    if (foundIds.has(outletId.toLowerCase())) continue;
    // Market filter
    if (isLondonMarket(market) && !outlet.isDualMarket && outlet.region !== 'uk') continue;
    if (market === 'broadway' && outlet.region === 'uk' && !outlet.isDualMarket) continue;
    missing.push({ id: outletId, name: outlet.displayName || outletId, tier: outlet.tier, domain: outlet.domain });
  }

  return missing.sort((a, b) => a.tier - b.tier); // T1 first
}

/**
 * Check readiness for broadcast
 */
function checkReadiness(showId, market = 'broadway') {
  const { MIN_REVIEWS, MIN_T1_REVIEWS, MIN_T2_REVIEWS, MIN_HIGH_CONFIDENCE } = getThresholds(market);
  const reviews = JSON.parse(fs.readFileSync(REVIEWS_PATH, 'utf8'));
  const registry = JSON.parse(fs.readFileSync(OUTLET_REGISTRY_PATH, 'utf8'));
  const outlets = registry.outlets || registry;
  const arr = Array.isArray(reviews.reviews || reviews) ? (reviews.reviews || reviews) : Object.values(reviews.reviews || reviews);

  const showRevs = arr.filter(r => r.showId === showId && r.assignedScore > 0);
  const t1 = showRevs.filter(r => { const o = outlets[r.outletId]; return o && o.tier === 1; }).length;
  const t2 = showRevs.filter(r => { const o = outlets[r.outletId]; return o && o.tier === 2; }).length;
  const hiConf = showRevs.filter(r => r.scoreConfidence === 'high' || r.scoreConfidence === 'medium').length;

  return {
    total: showRevs.length,
    t1,
    t2,
    highConfidence: hiConf,
    ready: showRevs.length >= MIN_REVIEWS && t1 >= MIN_T1_REVIEWS && t2 >= MIN_T2_REVIEWS && hiConf >= MIN_HIGH_CONFIDENCE,
    reasons: [
      showRevs.length < MIN_REVIEWS ? `${showRevs.length}/${MIN_REVIEWS} total` : null,
      t1 < MIN_T1_REVIEWS ? `T1:${t1}/${MIN_T1_REVIEWS}` : null,
      t2 < MIN_T2_REVIEWS ? `T2:${t2}/${MIN_T2_REVIEWS}` : null,
      hiConf < MIN_HIGH_CONFIDENCE ? `hi-conf:${hiConf}/${MIN_HIGH_CONFIDENCE}` : null,
    ].filter(Boolean),
  };
}

/**
 * Run Layer 1: Aggregators
 * Calls the existing aggregator functions from gather-reviews.js
 */
async function runAggregators(show) {
  console.log('\n[Layer 1] Aggregators...');
  const results = [];
  const year = new Date(show.openingDate).getFullYear();
  const isOffBroadway = show.category === 'off-broadway';
  const isWestEnd = isLondonMarket(show.category);

  // 1a. DTLI
  try {
    console.log('  Checking DTLI...');
    const dtli = await searchDTLI(show);
    if (dtli && dtli.html) {
      const validation = await validatePageMatchesShow(dtli.html, show.title, {
        openingYear: year,
      });
      if (validation.valid) {
        const reviews = extractDTLIReviews(dtli.html, show.id, dtli.url);
        console.log(`  DTLI: ${reviews.length} reviews found`);
        results.push(...reviews);
      } else {
        console.log(`  DTLI: page mismatch — ${validation.reason}`);
      }
    } else {
      console.log('  DTLI: not found');
    }
  } catch (err) {
    console.log(`  DTLI error: ${err.message}`);
  }

  // 1b. Show Score
  try {
    console.log('  Checking Show Score...');
    const ss = await searchShowScore(show);
    if (ss && ss.html) {
      const validation = await validatePageMatchesShow(ss.html, show.title, {
        openingYear: year,
      });
      if (validation.valid) {
        // Playwright-extracted reviews take priority
        if (ss.reviews && ss.reviews.length > 0) {
          console.log(`  Show Score: ${ss.reviews.length} reviews (Playwright)`);
          for (const r of ss.reviews) {
            results.push({
              showId: show.id,
              outletId: r.outlet ? r.outlet.toLowerCase().replace(/[^a-z0-9]+/g, '-') : 'unknown',
              outlet: r.outlet || 'Unknown',
              criticName: r.critic || 'Unknown',
              url: r.url,
              excerpt: r.excerpt,
              publishDate: r.date,
              source: 'show-score',
            });
          }
        } else {
          const reviews = extractShowScoreReviews(ss.html, show.id);
          console.log(`  Show Score: ${reviews.length} reviews (HTML)`);
          results.push(...reviews);
        }
      } else {
        console.log(`  Show Score: page mismatch — ${validation.reason}`);
      }
    } else {
      console.log('  Show Score: not found');
    }
  } catch (err) {
    console.log(`  Show Score error: ${err.message}`);
  }

  // 1c. BWW Review Roundup (skip for off-Broadway)
  if (!isOffBroadway) {
    try {
      console.log('  Checking BWW Review Roundup...');
      const bww = await searchBWWRoundup(show, year);
      if (bww && bww.html) {
        const reviews = extractBWWRoundupReviews(bww.html, show.id, bww.url);
        console.log(`  BWW RR: ${reviews.length} reviews found`);
        results.push(...reviews);
      } else {
        console.log('  BWW RR: not found');
      }
    } catch (err) {
      console.log(`  BWW RR error: ${err.message}`);
    }
  }

  console.log(`  [Layer 1 Total] ${results.length} reviews from aggregators`);
  return results;
}

/**
 * Run Layer 2: RSS Feeds
 */
async function runRSSFeeds(showTitle, knownUrls) {
  console.log('\n[Layer 2] RSS Feeds...');
  try {
    const results = await checkRSSFeeds(showTitle, {
      maxHoursAgo: 72,
      knownUrls,
      verbose: true,
    });
    console.log(`  [Layer 2 Total] ${results.length} reviews from RSS`);
    return results;
  } catch (err) {
    console.log(`  RSS error: ${err.message}`);
    return [];
  }
}

/**
 * Run Layer 3: Direct Site Search
 */
async function runSiteSearch(showTitle, missingOutletIds, knownUrls, market = 'broadway') {
  console.log('\n[Layer 3] Site Search...');

  // Only search outlets that have site-search configs AND are missing
  const searchable = missingOutletIds.filter(id => SITE_SEARCH_ENDPOINTS[id]);
  if (searchable.length === 0) {
    console.log('  No searchable outlets missing');
    return [];
  }

  console.log(`  Searching ${searchable.length} outlets: ${searchable.join(', ')}`);

  try {
    const results = await searchOutletSites(showTitle, searchable, {
      knownUrls,
      verbose: true,
      skipJs: !process.env.SCRAPINGBEE_API_KEY, // Skip JS-rendered if no API key
      market,
    });
    console.log(`  [Layer 3 Total] ${results.length} reviews from site search`);
    return results;
  } catch (err) {
    console.log(`  Site search error: ${err.message}`);
    return [];
  }
}

/**
 * Run Layer 4: SERP Backup
 */
async function runSERPBackup(show, missingOutlets, knownUrls) {
  console.log('\n[Layer 4] SERP Backup...');

  if (!process.env.SCRAPINGBEE_API_KEY && !process.env.BRIGHTDATA_TOKEN) {
    console.log('  Skipped: no SERP API keys');
    return [];
  }

  const results = [];
  const SERP_BUDGET = 30; // Conservative per-cycle budget
  let calls = 0;

  for (const outlet of missingOutlets) {
    if (calls >= SERP_BUDGET) {
      console.log(`  SERP budget exhausted (${SERP_BUDGET} calls)`);
      break;
    }
    if (!outlet.domain) continue;

    try {
      process.stdout.write(`  ${outlet.name}... `);
      calls++;

      const reviewObj = {
        showId: show.id,
        outletId: outlet.id,
        outlet: outlet.name,
        criticName: 'Unknown',
        url: '',
      };
      const result = await discoverCorrectUrl(
        reviewObj,
        process.env.SCRAPINGBEE_API_KEY || '',
        {
          brightDataKey: process.env.BRIGHTDATA_TOKEN || '',
          preferSpeed: true, // Opening night — latency matters
        }
      );

      const url = (result && result !== '__SERP_UNAVAILABLE__') ? result : null;
      if (url && !knownUrls.has(url)) {
        console.log('found');
        results.push({
          showId: show.id,
          outletId: outlet.id,
          outlet: outlet.name,
          criticName: 'Unknown',
          url,
          source: 'serp-discovery',
        });
      } else {
        console.log(url ? 'already known' : 'not found');
      }
    } catch (err) {
      console.log(`error: ${err.message}`);
    }
  }

  console.log(`  [Layer 4 Total] ${results.length} reviews from SERP (${calls} calls)`);
  return results;
}

/**
 * Create review files for newly discovered reviews.
 * Handles dedup against existing files.
 */
function processDiscoveredReviews(showId, reviews, knownUrls, options = {}) {
  const { allowOffBroadway = false, allowWestEnd = false } = options;
  let created = 0;
  let skipped = 0;
  let rejected = 0;

  for (const review of reviews) {
    // Skip if URL already known
    if (review.url && knownUrls.has(review.url)) {
      skipped++;
      continue;
    }

    // Skip BWW excerpt-only reviews (no URL) — they need special handling
    if (!review.url && review.bwwExcerpt) {
      continue; // BWW excerpt merge is handled by gatherReviewsForShow
    }

    if (!review.url) {
      skipped++;
      continue;
    }

    if (DRY_RUN) {
      console.log(`  [DRY RUN] Would create: ${review.outletId || review.outlet} — ${review.url}`);
      created++;
      continue;
    }

    const result = createReviewFile(showId, review, { allowOffBroadway, allowWestEnd });
    if (result === true) {
      created++;
      knownUrls.add(review.url);
    } else if (typeof result === 'string') {
      rejected++;
    } else {
      skipped++; // Already exists
    }
  }

  return { created, skipped, rejected };
}

/**
 * Main poll cycle
 */
async function pollCycle() {
  if (!SHOW_ID) {
    console.error('Usage: node scripts/opening-night-poller.js --show=SHOW_ID');
    process.exit(1);
  }

  console.log('╔══════════════════════════════════════════════╗');
  console.log('║     Opening Night Review Poller              ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`Show: ${SHOW_ID}`);
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);

  // Load show data
  const show = loadShowData(SHOW_ID);
  if (!show) {
    console.error(`Show not found: ${SHOW_ID}`);
    process.exit(1);
  }

  const market = isLondonMarket(show.category) ? 'west-end' : 'broadway';
  const isOffBroadway = show.category === 'off-broadway';
  const isWestEnd = isLondonMarket(show.category);
  console.log(`Title: ${show.title}`);
  console.log(`Market: ${market}`);

  // Pre-poll state
  const knownUrls = getKnownUrls(SHOW_ID);
  const preStatus = checkReadiness(SHOW_ID, market);
  console.log(`\nPre-poll: ${preStatus.total} scored reviews (T1:${preStatus.t1} T2:${preStatus.t2} hi-conf:${preStatus.highConfidence})`);
  if (preStatus.ready) {
    console.log('Show is ALREADY broadcast-ready!');
  }

  // ── Layer 1: Aggregators ──
  const aggResults = await runAggregators(show);

  // ── Layer 2: RSS ──
  const rssResults = await runRSSFeeds(show.title, knownUrls);

  // ── Layer 3: Site Search ──
  let siteSearchResults = [];
  if (!SKIP_SITE_SEARCH) {
    const foundOutletIds = getFoundOutletIds(SHOW_ID);
    // Add outlets found in layers 1-2
    for (const r of [...aggResults, ...rssResults]) {
      if (r.outletId) foundOutletIds.add(r.outletId.toLowerCase());
    }
    const missingIds = getMissingT1T2Outlets(SHOW_ID, market)
      .map(o => o.id)
      .filter(id => !foundOutletIds.has(id.toLowerCase()));
    siteSearchResults = await runSiteSearch(show.title, missingIds, knownUrls, market);
  } else {
    console.log('\n[Layer 3] Site Search... SKIPPED (--skip-site-search)');
  }

  // ── Layer 4: SERP ──
  let serpResults = [];
  if (!SKIP_SERP) {
    const foundOutletIds = getFoundOutletIds(SHOW_ID);
    for (const r of [...aggResults, ...rssResults, ...siteSearchResults]) {
      if (r.outletId) foundOutletIds.add(r.outletId.toLowerCase());
    }
    const missingOutlets = getMissingT1T2Outlets(SHOW_ID, market)
      .filter(o => !foundOutletIds.has(o.id.toLowerCase()));
    if (missingOutlets.length > 0) {
      serpResults = await runSERPBackup(show, missingOutlets, knownUrls);
    } else {
      console.log('\n[Layer 4] SERP Backup... all T1/T2 outlets found');
    }
  } else {
    console.log('\n[Layer 4] SERP Backup... SKIPPED (--skip-serp)');
  }

  // ── Process discovered reviews ──
  const allDiscovered = [...aggResults, ...rssResults, ...siteSearchResults, ...serpResults];
  console.log(`\n━━━ Processing ${allDiscovered.length} discovered reviews ━━━`);

  const { created, skipped, rejected } = processDiscoveredReviews(
    SHOW_ID,
    allDiscovered,
    knownUrls,
    { allowOffBroadway: isOffBroadway, allowWestEnd: isWestEnd }
  );

  // ── Post-poll status ──
  const postStatus = checkReadiness(SHOW_ID, market);
  const newReviews = postStatus.total - preStatus.total;

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  POLL CYCLE RESULTS');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  Discovered: ${allDiscovered.length} (agg:${aggResults.length} rss:${rssResults.length} site:${siteSearchResults.length} serp:${serpResults.length})`);
  console.log(`  Files created: ${created} | Skipped: ${skipped} | Rejected: ${rejected}`);
  console.log(`  Scored reviews: ${preStatus.total} → ${postStatus.total} (+${newReviews})`);
  console.log(`  T1: ${postStatus.t1} | T2: ${postStatus.t2} | Hi-conf: ${postStatus.highConfidence}`);

  if (postStatus.ready) {
    console.log('  Status: BROADCAST READY ✅');
  } else {
    console.log(`  Status: NOT READY — ${postStatus.reasons.join(', ')}`);
  }
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // GitHub Actions outputs
  console.log(`\n::set-output name=ready::${postStatus.ready}`);
  console.log(`::set-output name=new_reviews::${newReviews}`);
  console.log(`::set-output name=total_scored::${postStatus.total}`);
  console.log(`::set-output name=t1_count::${postStatus.t1}`);
  console.log(`::set-output name=t2_count::${postStatus.t2}`);
  console.log(`::set-output name=files_created::${created}`);

  // Also write to GITHUB_OUTPUT if available
  if (process.env.GITHUB_OUTPUT) {
    const outputLines = [
      `ready=${postStatus.ready}`,
      `new_reviews=${newReviews}`,
      `total_scored=${postStatus.total}`,
      `t1_count=${postStatus.t1}`,
      `t2_count=${postStatus.t2}`,
      `files_created=${created}`,
    ].join('\n');
    fs.appendFileSync(process.env.GITHUB_OUTPUT, outputLines + '\n');
  }
}

if (require.main === module) {
  pollCycle().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

module.exports = { pollCycle, checkReadiness, getMissingT1T2Outlets };
