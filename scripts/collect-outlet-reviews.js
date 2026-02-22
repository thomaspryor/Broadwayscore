#!/usr/bin/env node
/**
 * Market-Agnostic Outlet-Based SERP Review Collector
 *
 * Discovers missing reviews by searching for specific outlet+show combinations
 * via SERP APIs. Creates review-text files with source: 'outlet-serp-discovery'.
 *
 * Usage:
 *   node scripts/collect-outlet-reviews.js --market west-end [options]
 *
 * Options:
 *   --market west-end|broadway    Market to collect for (required)
 *   --show SHOW_ID                Collect for a single show only
 *   --tier 1                      Only search tier 1 outlets (default: 1+2)
 *   --max-tier 3                  Include up to tier 3 (default: 2)
 *   --dry-run                     Show what would be searched, don't write files
 *   --skip-existing               Skip shows that already have reviews from an outlet (default: on)
 *   --max-shows N                 Limit to N shows (for testing)
 *   --max-searches N              Limit total SERP searches (for cost control)
 */

const fs = require('fs');
const path = require('path');
const { discoverCorrectUrl, OUTLET_DOMAINS, getShowInfo } = require('./lib/url-discovery');

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
    tier2: ['timeout', 'theatermania', 'nypost', 'deadline', 'ew', 'nydailynews'],
    tier3: ['broadwayworld', 'theaterscene', 'talkinbroadway', 'theatrely'],
  },
};

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    market: null,
    showFilter: null,
    minTier: 1,
    maxTier: 2,
    dryRun: false,
    skipExisting: true,
    maxShows: Infinity,
    maxSearches: Infinity,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--market': opts.market = args[++i]; break;
      case '--show': opts.showFilter = args[++i]; break;
      case '--tier': opts.minTier = parseInt(args[++i]); opts.maxTier = opts.minTier; break;
      case '--max-tier': opts.maxTier = parseInt(args[++i]); break;
      case '--dry-run': opts.dryRun = true; break;
      case '--no-skip-existing': opts.skipExisting = false; break;
      case '--max-shows': opts.maxShows = parseInt(args[++i]); break;
      case '--max-searches': opts.maxSearches = parseInt(args[++i]); break;
    }
  }

  if (!opts.market || !MARKET_OUTLETS[opts.market]) {
    console.error('Usage: node scripts/collect-outlet-reviews.js --market west-end|broadway [options]');
    console.error('Available markets:', Object.keys(MARKET_OUTLETS).join(', '));
    process.exit(1);
  }

  return opts;
}

function getTargetOutlets(market, minTier, maxTier) {
  const config = MARKET_OUTLETS[market];
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

  const fileName = `${outletId}--unknown.json`;
  const filePath = path.join(showDir, fileName);

  // Don't overwrite existing files
  if (fs.existsSync(filePath)) {
    console.log(`    SKIP (file exists): ${fileName}`);
    return false;
  }

  const data = {
    showId,
    showTitle,
    outlet: outletName,
    outletId,
    criticName: 'Unknown',
    url,
    source: 'outlet-serp-discovery',
    contentTier: 'url-only',
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

async function main() {
  const opts = parseArgs();
  const shows = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));

  // Get SERP API keys from environment
  const scrapingBeeKey = process.env.SCRAPINGBEE_API_KEY || '';
  const brightDataKey = process.env.BRIGHTDATA_API_KEY || '';
  if (!scrapingBeeKey && !brightDataKey) {
    console.error('ERROR: Need SCRAPINGBEE_API_KEY or BRIGHTDATA_API_KEY in environment');
    console.error('Load from .env: eval $(grep -E "^(SCRAPINGBEE|BRIGHTDATA)" .env | sed "s/^/export /")');
    process.exit(1);
  }

  const targetShows = shows.shows
    .filter(s => s.category === opts.market)
    .filter(s => !opts.showFilter || s.id === opts.showFilter)
    .slice(0, opts.maxShows);

  const targetOutlets = getTargetOutlets(opts.market, opts.minTier, opts.maxTier);

  console.log(`=== Outlet-Based SERP Collector ===`);
  console.log(`Market: ${opts.market}`);
  console.log(`Shows: ${targetShows.length}`);
  console.log(`Target outlets: ${targetOutlets.map(o => o.id).join(', ')}`);
  console.log(`Tiers: ${opts.minTier}-${opts.maxTier}`);
  console.log(`Dry run: ${opts.dryRun}`);
  console.log(`Max searches: ${opts.maxSearches === Infinity ? 'unlimited' : opts.maxSearches}`);
  console.log('');

  let totalSearches = 0;
  let totalFound = 0;
  let totalWritten = 0;
  let totalSkipped = 0;

  for (const show of targetShows) {
    const existingOutlets = opts.skipExisting ? getExistingOutlets(show.id, registry) : new Set();

    // Find which target outlets are missing
    const missing = targetOutlets.filter(o => {
      if (existingOutlets.has(o.id)) return false;
      // Check aliases
      const info = registry.outlets[o.id];
      if (info && info.aliases) {
        return !info.aliases.some(a => existingOutlets.has(a.toLowerCase()));
      }
      return true;
    });

    if (missing.length === 0) {
      continue;
    }

    console.log(`\n${show.title} (${show.id}) — ${missing.length} missing outlets`);

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

      // Build a minimal review object for discoverCorrectUrl
      const fakeReview = {
        showId: show.id,
        outletId: outlet.id,
        outlet: outletName,
        criticName: null,
        url: null,
      };

      console.log(`  [${outlet.id}] Searching site:${domain} for "${show.title}"...`);
      totalSearches++;

      try {
        const result = await discoverCorrectUrl(fakeReview, scrapingBeeKey, {
          brightDataKey,
          log: (msg) => {}, // Suppress verbose logging
        });

        if (result && result !== '__SERP_UNAVAILABLE__') {
          console.log(`    FOUND: ${result}`);
          totalFound++;

          // Validate URL via HEAD request before writing
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

      // Rate limit: 1.5s between searches
      await sleep(1500);
    }

    if (totalSearches >= opts.maxSearches) break;
  }

  console.log('\n=== Summary ===');
  console.log(`Searches: ${totalSearches}`);
  console.log(`Found: ${totalFound}`);
  console.log(`Written: ${totalWritten}`);
  console.log(`Skipped (no domain): ${totalSkipped}`);
  console.log(`Dry run: ${opts.dryRun}`);
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

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
