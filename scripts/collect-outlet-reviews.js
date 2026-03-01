#!/usr/bin/env node
/**
 * Outlet-First SERP Review Collector
 *
 * Discovers missing reviews by searching known T1/T2 outlets directly via Google
 * SERP with date filtering. This is the PRIMARY review discovery mechanism —
 * aggregators (ShowScore, DTLI, BWW) supplement with star ratings and T3 discovery.
 *
 * Date filtering prevents cross-production contamination for revivals.
 *
 * Usage:
 *   node scripts/collect-outlet-reviews.js --market broadway [options]
 *   node scripts/collect-outlet-reviews.js --shows hamilton-2015,cabaret-2024
 *
 * Options:
 *   --market west-end|broadway|off-broadway  Market to collect for
 *   --shows ID1,ID2,...                      Specific show IDs (auto-detects market)
 *   --show SHOW_ID                           Single show ID (legacy alias for --shows)
 *   --tier 1                                 Only search tier 1 outlets
 *   --max-tier 3                             Include up to tier 3 (default: 2)
 *   --broad-search                           Also do a non-site-scoped T3 search (default: off)
 *   --dry-run                                Show what would be searched, don't write files
 *   --no-skip-existing                       Search even if outlet already has a review
 *   --max-shows N                            Limit to N shows (for testing)
 *   --max-searches N                         Limit total SERP searches (for cost control)
 */

const fs = require('fs');
const path = require('path');
const { discoverCorrectUrl, OUTLET_DOMAINS, calculateDateWindow } = require('./lib/url-discovery');
const { generateReviewFilename, findExistingReviewFile, resolveOutletFromUrl } = require('./lib/review-normalization');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const REGISTRY_PATH = path.join(__dirname, '..', 'data', 'outlet-registry.json');

// Market-specific outlet target lists (outlet IDs from registry)
const MARKET_OUTLETS = {
  'west-end': {
    tier1: ['guardian', 'telegraph', 'evening-standard', 'the-times-uk', 'dailymail'],
    tier2: ['stage-uk', 'whatsonstage', 'timeout-london', 'independent', 'financial-times-uk', 'london-theatre', 'inews'],
    tier3: ['the-arts-desk', 'everythingtheatre', 'thereviewshub', 'metro-uk', 'west-end-best-friend', 'londonist'],
  },
  'broadway': {
    tier1: ['nytimes', 'vulture', 'variety', 'hollywood-reporter'],
    tier2: ['timeout', 'theatermania', 'nypost', 'deadline', 'ew', 'nydailynews', 'observer', 'wsj', 'newyorker'],
    tier3: ['broadwayworld', 'theaterscene', 'talkinbroadway', 'theatrely', 'newyorktheater', 'frontmezzjunkies'],
  },
  'off-broadway': {
    tier1: ['nytimes', 'vulture', 'variety', 'hollywood-reporter'],
    tier2: ['timeout', 'theatermania', 'nypost', 'deadline', 'ew', 'observer', 'theatrely'],
    tier3: ['newyorktheater', 'talkinbroadway', 'stage-and-cinema', 'frontmezzjunkies', 'broadwayworld'],
  },
};

// Domains to exclude from broad T3 search results (aggregators, not outlets)
const AGGREGATOR_DOMAINS = new Set([
  'broadwayworld.com', 'showscore.com', 'didtheylikeit.com', 'playbill.com',
  'wikipedia.org', 'ibdb.com', 'nyctheatre.com', 'reddit.com', 'twitter.com',
  'facebook.com', 'instagram.com', 'youtube.com', 'tiktok.com',
  'todaytix.com', 'telecharge.com', 'ticketmaster.com', 'seatgeek.com',
]);

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    market: null,
    showIds: null,        // --shows or --show
    minTier: 1,
    maxTier: 2,
    broadSearch: false,
    dryRun: false,
    skipExisting: true,
    maxShows: Infinity,
    maxSearches: Infinity,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--market': opts.market = args[++i]; break;
      case '--show': opts.showIds = [args[++i]]; break;
      case '--shows': opts.showIds = args[++i].split(',').map(s => s.trim()).filter(Boolean); break;
      case '--tier': opts.minTier = parseInt(args[++i]); opts.maxTier = opts.minTier; break;
      case '--max-tier': opts.maxTier = parseInt(args[++i]); break;
      case '--broad-search': opts.broadSearch = true; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--no-skip-existing': opts.skipExisting = false; break;
      case '--max-shows': opts.maxShows = parseInt(args[++i]); break;
      case '--max-searches': opts.maxSearches = parseInt(args[++i]); break;
    }
  }

  // --shows auto-detects market, --market required otherwise
  if (!opts.showIds && (!opts.market || !MARKET_OUTLETS[opts.market])) {
    console.error('Usage: node scripts/collect-outlet-reviews.js --market west-end|broadway|off-broadway [options]');
    console.error('   or: node scripts/collect-outlet-reviews.js --shows show-id-1,show-id-2');
    console.error('Available markets:', Object.keys(MARKET_OUTLETS).join(', '));
    process.exit(1);
  }

  return opts;
}

function getTargetOutlets(market, minTier, maxTier) {
  const config = MARKET_OUTLETS[market];
  if (!config) return [];
  const outlets = [];
  if (minTier <= 1 && maxTier >= 1) outlets.push(...config.tier1.map(id => ({ id, tier: 1 })));
  if (minTier <= 2 && maxTier >= 2) outlets.push(...config.tier2.map(id => ({ id, tier: 2 })));
  if (minTier <= 3 && maxTier >= 3) outlets.push(...(config.tier3 || []).map(id => ({ id, tier: 3 })));
  return outlets;
}

function getExistingOutlets(showId, registry) {
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  const existing = new Set();
  if (!fs.existsSync(showDir)) return existing;

  const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(showDir, f), 'utf8'));
      if (data.fabricatedEntry) continue;
      const oid = (data.outletId || data.outlet || '').toLowerCase();
      existing.add(oid);
      // Also add aliases
      if (registry.outlets[oid] && registry.outlets[oid].aliases) {
        for (const alias of registry.outlets[oid].aliases) {
          existing.add(alias.toLowerCase());
        }
      }
    } catch (e) {}
  }
  return existing;
}

function writeReviewFile(showId, outletId, url, showTitle, outletName, opts) {
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  if (!fs.existsSync(showDir)) fs.mkdirSync(showDir, { recursive: true });

  // Use normalized filename via review-normalization
  const fileName = generateReviewFilename(outletId, 'unknown');

  // Check for existing file (handles variant filenames)
  const existing = findExistingReviewFile(showDir, outletId, 'unknown');
  if (existing) {
    console.log(`    SKIP (file exists): ${existing}`);
    return false;
  }

  const filePath = path.join(showDir, fileName);

  const data = {
    showId,
    showTitle,
    outlet: outletName,
    outletId,
    criticName: 'Unknown',
    url,
    source: 'outlet-serp-discovery',
    contentTier: 'stub',
    collectedAt: new Date().toISOString(),
  };

  if (opts.dryRun) {
    console.log(`    DRY RUN: Would write ${fileName}`);
    return true;
  }

  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
  console.log(`    WROTE: ${fileName}`);
  return true;
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function validateUrl(url) {
  const https = require('https');
  const http = require('http');
  return new Promise((resolve) => {
    try {
      const mod = url.startsWith('https') ? https : http;
      const req = mod.request(url, { method: 'HEAD', timeout: 10000 }, (res) => {
        resolve(res.statusCode >= 200 && res.statusCode < 400);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    } catch (e) {
      resolve(false);
    }
  });
}

async function main() {
  const opts = parseArgs();
  const shows = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));

  // Get SERP API keys from environment
  const scrapingBeeKey = process.env.SCRAPINGBEE_API_KEY || '';
  const brightDataKey = process.env.BRIGHTDATA_TOKEN || '';
  if (!scrapingBeeKey && !brightDataKey) {
    console.error('ERROR: Need SCRAPINGBEE_API_KEY or BRIGHTDATA_TOKEN in environment');
    console.error('Load from .env: eval $(grep -E "^(SCRAPINGBEE|BRIGHTDATA)" .env | sed "s/^/export /")');
    process.exit(1);
  }

  // Build target show list
  let targetShows;
  if (opts.showIds) {
    // --shows mode: find each show by ID, auto-detect market
    targetShows = opts.showIds
      .map(id => shows.shows.find(s => s.id === id))
      .filter(s => {
        if (!s) return false;
        // Skip shows in previews — no reviews exist yet
        if (s.status === 'previews') {
          console.log(`SKIP (previews): ${s.id}`);
          return false;
        }
        return true;
      });
  } else {
    // --market mode: filter by category
    targetShows = shows.shows
      .filter(s => s.category === opts.market)
      .filter(s => s.status !== 'previews')
      .filter(s => !opts.showIds || opts.showIds.includes(s.id));
  }
  targetShows = targetShows.slice(0, opts.maxShows);

  console.log(`=== Outlet-First SERP Review Collector ===`);
  console.log(`Mode: ${opts.showIds ? `specific shows (${opts.showIds.length})` : `market: ${opts.market}`}`);
  console.log(`Shows: ${targetShows.length}`);
  console.log(`Tiers: ${opts.minTier}-${opts.maxTier}`);
  console.log(`Broad T3 search: ${opts.broadSearch}`);
  console.log(`Date filtering: enabled`);
  console.log(`Dry run: ${opts.dryRun}`);
  console.log(`Max searches: ${opts.maxSearches === Infinity ? 'unlimited' : opts.maxSearches}`);
  console.log('');

  let totalSearches = 0;
  let totalFound = 0;
  let totalWritten = 0;
  let totalSkipped = 0;

  for (const show of targetShows) {
    // Determine market for this show (auto-detect from category)
    const market = show.category || opts.market || 'broadway';
    const targetOutlets = getTargetOutlets(market, opts.minTier, opts.maxTier);

    if (targetOutlets.length === 0) {
      console.log(`SKIP (no outlets for market ${market}): ${show.id}`);
      continue;
    }

    const existingOutlets = opts.skipExisting ? getExistingOutlets(show.id, registry) : new Set();

    // Find which target outlets are missing
    const missing = targetOutlets.filter(o => {
      if (existingOutlets.has(o.id)) return false;
      const info = registry.outlets[o.id];
      if (info && info.aliases) {
        return !info.aliases.some(a => existingOutlets.has(a.toLowerCase()));
      }
      return true;
    });

    if (missing.length === 0 && !opts.broadSearch) {
      continue;
    }

    // Calculate date window for this show
    const dateRange = calculateDateWindow(show);
    if (dateRange) {
      const fmtDate = d => d.toISOString().split('T')[0];
      console.log(`\n${show.title} (${show.id}) — ${missing.length} missing outlets [${fmtDate(dateRange.dateMin)} to ${fmtDate(dateRange.dateMax)}]`);
    } else {
      console.log(`\n${show.title} (${show.id}) — ${missing.length} missing outlets [no date filter]`);
    }

    // --- Site-scoped T1/T2 outlet searches ---
    const foundOutlets = new Set();

    for (const outlet of missing) {
      if (totalSearches >= opts.maxSearches) {
        console.log('\n--- Max searches reached ---');
        break;
      }

      const outletInfo = registry.outlets[outlet.id];
      const outletName = outletInfo ? outletInfo.displayName : outlet.id;
      const domain = OUTLET_DOMAINS[outlet.id] || (outletInfo ? outletInfo.domain : null);

      if (!domain) {
        console.log(`  [${outlet.id}] SKIP — no domain configured`);
        totalSkipped++;
        continue;
      }

      const fakeReview = {
        showId: show.id,
        outletId: outlet.id,
        outlet: outletName,
        criticName: null,
        url: null,
      };

      console.log(`  [T${outlet.tier}] [${outlet.id}] site:${domain} "${show.title}"...`);
      totalSearches++;

      try {
        const result = await discoverCorrectUrl(fakeReview, scrapingBeeKey, {
          brightDataKey,
          dateRange,
          log: () => {},
        });

        if (result && result !== '__SERP_UNAVAILABLE__') {
          console.log(`    FOUND: ${result}`);
          totalFound++;
          foundOutlets.add(outlet.id);

          const valid = await validateUrl(result);
          if (valid) {
            const written = writeReviewFile(show.id, outlet.id, result, show.title, outletName, opts);
            if (written) totalWritten++;
          } else {
            console.log(`    INVALID (HTTP error): ${result}`);
          }
        } else if (result === '__SERP_UNAVAILABLE__') {
          console.log(`    SERP UNAVAILABLE — stopping`);
          break;
        } else {
          console.log(`    Not found`);
        }
      } catch (e) {
        console.log(`    ERROR: ${e.message}`);
      }

      await sleep(1500);
    }

    if (totalSearches >= opts.maxSearches) break;

    // --- Broad T3 search (non-site-scoped, catches unknown outlets) ---
    if (opts.broadSearch && totalSearches < opts.maxSearches) {
      const marketKeyword = market === 'west-end' ? 'West End'
        : market === 'off-broadway' ? 'Off-Broadway'
        : 'Broadway';
      const broadQuery = `"${show.title}" ${marketKeyword} review`;

      console.log(`  [BROAD] "${show.title}" ${marketKeyword} review...`);
      totalSearches++;

      try {
        // Use ScrapingBee directly for broad search (not discoverCorrectUrl which needs outletId)
        const { _serpViaScrapingBee, _serpViaBrightData } = (() => {
          // We need the raw SERP functions — use discoverCorrectUrl with a dummy outlet
          // and capture the results. Instead, just do a simple search.
          // For broad search, we'll construct a fake review and use the query building
          // but the matching won't work well. Better to search directly.
          return {};
        })();

        // Use discoverCorrectUrl with no outlet domain — it'll do a non-site-scoped search
        const fakeReview = {
          showId: show.id,
          outletId: '',
          outlet: '',
          criticName: null,
          url: null,
        };

        // discoverCorrectUrl without domain falls back to outlet-name-based search
        // For broad T3, we just want any results. Skip for now — the site-scoped
        // searches cover the most important outlets. Broad search can be added
        // when we expose the raw SERP functions.
        console.log(`    (Broad search not yet wired — site-scoped T1/T2 covers primary outlets)`);
      } catch (e) {
        console.log(`    ERROR: ${e.message}`);
      }
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Searches: ${totalSearches}`);
  console.log(`Found: ${totalFound}`);
  console.log(`Written: ${totalWritten}`);
  console.log(`Skipped (no domain): ${totalSkipped}`);
  console.log(`Dry run: ${opts.dryRun}`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
