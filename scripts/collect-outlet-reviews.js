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
 *   --max-outlets N                           Max outlets per show (default: 60, T1/T2 first)
 *   --open-only                              Only search open/previews shows (for weekly cron)
 */

const fs = require('fs');
const path = require('path');
const { discoverCorrectUrl, OUTLET_DOMAINS, calculateDateWindow } = require('./lib/url-discovery');
const { generateReviewFilename, findExistingReviewFile, resolveOutletFromUrl } = require('./lib/review-normalization');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const REGISTRY_PATH = path.join(__dirname, '..', 'data', 'outlet-registry.json');

// Hardcoded fallback outlet lists (used only if registry has no outlets for a market)
const MARKET_OUTLETS_FALLBACK = {
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

const VALID_MARKETS = ['broadway', 'off-broadway', 'west-end'];

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
    maxOutlets: 60,       // Cap outlets per show (T1/T2 first, T3 fills remainder)
    openOnly: false,
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
      case '--max-outlets': opts.maxOutlets = parseInt(args[++i]); break;
      case '--open-only': opts.openOnly = true; break;
    }
  }

  // --shows auto-detects market, --market required otherwise
  if (!opts.showIds && (!opts.market || !VALID_MARKETS.includes(opts.market))) {
    console.error('Usage: node scripts/collect-outlet-reviews.js --market west-end|broadway|off-broadway [options]');
    console.error('   or: node scripts/collect-outlet-reviews.js --shows show-id-1,show-id-2');
    console.error('Available markets:', VALID_MARKETS.join(', '));
    process.exit(1);
  }

  return opts;
}

/**
 * Build target outlet list from registry. Falls back to hardcoded list if registry
 * yields no results for a market.
 *
 * Market filtering:
 *   - west-end: region === 'london' OR isDualMarket
 *   - broadway / off-broadway: region is undefined/null OR is a US city (NOT 'london') OR isDualMarket
 *
 * Sorted by tier (T1 first), then alphabetically within tier.
 * Capped at maxOutlets.
 */
function getTargetOutlets(market, minTier, maxTier, registry, maxOutlets) {
  const outlets = [];

  for (const [id, info] of Object.entries(registry.outlets)) {
    // Must have a domain to be SERP-searchable
    if (!info.domain && !OUTLET_DOMAINS[id]) continue;

    // Tier filter
    const tier = info.tier || 3;
    if (tier < minTier || tier > maxTier) continue;

    // Market filter
    const isLondon = info.region === 'london';
    const isDual = info.isDualMarket === true;

    if (market === 'west-end') {
      // West End: London-based outlets + dual-market outlets
      if (!isLondon && !isDual) continue;
    } else {
      // Broadway / Off-Broadway: non-London outlets + dual-market outlets
      if (isLondon && !isDual) continue;
    }

    outlets.push({ id, tier });
  }

  // Sort: T1 first, then T2, then T3; alphabetical within tier
  outlets.sort((a, b) => a.tier - b.tier || a.id.localeCompare(b.id));

  // Cap at maxOutlets
  const capped = maxOutlets ? outlets.slice(0, maxOutlets) : outlets;

  // Fallback to hardcoded list if registry yielded nothing
  if (capped.length === 0) {
    const config = MARKET_OUTLETS_FALLBACK[market];
    if (!config) return [];
    const fallback = [];
    if (minTier <= 1 && maxTier >= 1) fallback.push(...config.tier1.map(id => ({ id, tier: 1 })));
    if (minTier <= 2 && maxTier >= 2) fallback.push(...config.tier2.map(id => ({ id, tier: 2 })));
    if (minTier <= 3 && maxTier >= 3) fallback.push(...(config.tier3 || []).map(id => ({ id, tier: 3 })));
    return fallback;
  }

  return capped;
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

// URL path patterns that are clearly NOT reviews
const NON_REVIEW_URL_PATTERNS = [
  /\/box-?office/i, /\/grosses?\b/i, /\/gross-?report/i,
  /\/gallery\b/i, /\/photos?\b/i, /\/pictures?\b/i, /\/slideshow/i,
  /\/video\b/i, /\/videos\b/i, /\/podcast/i,
  /\/contributor/i, /\/author\//i, /\/writers?\//i, /\/staff\//i,
  /\/listing\b/i, /\/listings\b/i, /\/events?\//i,
  /\/first-look/i, /\/behind-the-scenes/i, /\/sneak-peek/i,
  /\/best-of\b/i, /\/ranked\b/i, /\/ranking\b/i,
  /\/closing-?notice/i, /\/closing-?date/i, /\/closing-?announcement/i,
  /\/tv-review/i, /\/film-review/i, /\/movie-review/i, /\/book-review/i,
  /\/album-review/i, /\/concert-review/i, /\/music-review/i,
  /\/award/i, /\/tony-?award/i, /\/nomination/i,
  /\/ticket/i, /\/deals?\b/i, /\/discount/i, /\/lottery\b/i, /\/rush\b/i,
  /\/cast-?announcement/i, /\/casting\b/i,
];

/**
 * Check if a SERP result looks like an actual theater review.
 * Uses both URL path and SERP title. Errs on the side of inclusion
 * (only blocks clear non-review patterns).
 */
function looksLikeReview(url, serpTitle) {
  const urlLower = url.toLowerCase();

  // Block obvious non-review URL patterns
  for (const pattern of NON_REVIEW_URL_PATTERNS) {
    if (pattern.test(urlLower)) return false;
  }

  // If title or URL contains strong review signals, definitely include
  const combined = `${urlLower} ${(serpTitle || '').toLowerCase()}`;
  if (/\breview\b/.test(combined) || /\bcritic\b/.test(combined) || /\bverdict\b/.test(combined)) {
    return true;
  }

  // Otherwise, pass through — downstream quality gates catch false positives
  return true;
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
      .filter(s => opts.market === 'broadway' ? (!s.category || s.category === 'broadway') : s.category === opts.market)
      .filter(s => s.status !== 'previews')
      .filter(s => !opts.showIds || opts.showIds.includes(s.id));
  }

  // --open-only: filter to open/previews shows (for weekly cron targeting current shows)
  if (opts.openOnly) {
    targetShows = targetShows.filter(s => s.status === 'open' || s.status === 'previews');
  }

  targetShows = targetShows.slice(0, opts.maxShows);

  // Show outlet counts for first show to give a sense of registry coverage
  const sampleMarket = targetShows.length > 0 ? (targetShows[0].category || opts.market || 'broadway') : (opts.market || 'broadway');
  const sampleOutlets = getTargetOutlets(sampleMarket, opts.minTier, opts.maxTier, registry, opts.maxOutlets);
  const tierCounts = {};
  sampleOutlets.forEach(o => { tierCounts[`T${o.tier}`] = (tierCounts[`T${o.tier}`] || 0) + 1; });

  console.log(`=== Outlet-First SERP Review Collector ===`);
  console.log(`Mode: ${opts.showIds ? `specific shows (${opts.showIds.length})` : `market: ${opts.market}`}`);
  console.log(`Shows: ${targetShows.length}`);
  console.log(`Tiers: ${opts.minTier}-${opts.maxTier}`);
  console.log(`Outlets per show: ${sampleOutlets.length} (${Object.entries(tierCounts).map(([k, v]) => `${k}:${v}`).join(', ')})`);
  console.log(`Max outlets: ${opts.maxOutlets}`);
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
    const targetOutlets = getTargetOutlets(market, opts.minTier, opts.maxTier, registry, opts.maxOutlets);

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
          returnMetadata: true,
          log: () => {},
        });

        if (result && result !== '__SERP_UNAVAILABLE__' && typeof result === 'object') {
          const { url: foundUrl, serpTitle } = result;
          console.log(`    FOUND: ${foundUrl}`);
          if (serpTitle) console.log(`    TITLE: ${serpTitle}`);

          // Review-relevance filter: block obvious non-review URLs
          if (!looksLikeReview(foundUrl, serpTitle)) {
            console.log(`    SKIP (non-review URL pattern)`);
            totalSkipped++;
          } else {
            totalFound++;
            foundOutlets.add(outlet.id);

            // Skip URL validation for paywalled/metered outlets — they block HEAD requests
            const accessModel = outletInfo ? outletInfo.accessModel : 'free';
            const skipValidation = accessModel === 'paywalled' || accessModel === 'metered';

            const valid = skipValidation || await validateUrl(foundUrl);
            if (valid) {
              if (skipValidation) console.log(`    SKIP validation (${accessModel} outlet)`);
              const written = writeReviewFile(show.id, outlet.id, foundUrl, show.title, outletName, opts);
              if (written) totalWritten++;
            } else {
              console.log(`    INVALID (HTTP error): ${foundUrl}`);
            }
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
  console.log(`Skipped (no domain / non-review): ${totalSkipped}`);
  console.log(`Open only: ${opts.openOnly}`);
  console.log(`Dry run: ${opts.dryRun}`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
