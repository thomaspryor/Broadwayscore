#!/usr/bin/env node
/**
 * Enrich shows.json with Telecharge/Ticketmaster ticket links based on venue mapping.
 *
 * Broadway theaters map to either Telecharge (Shubert, ATG, Roundabout, etc.) or
 * Ticketmaster (Nederlander, Disney, some ATG). This script:
 *
 * 1. For Telecharge venues: constructs deterministic URL from show title
 *    (Telecharge blocks HEAD requests via Akamai queue-it, so no HTTP verification)
 * 2. For Ticketmaster venues: discovers URL via SERP search (needs artist ID in URL)
 * 3. Inserts platform link after TodayTix in ticketLinks array
 *
 * Usage: node scripts/enrich-ticket-platform-links.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { serpQuery } = require('./lib/url-discovery');
const { buildTelechargeUrl, normalizeShowName } = require('./lib/url-utils');
const { loadShows, saveShows } = require('./lib/shows-write-guard');
const { isBroadwayCategory } = require('./lib/venue-classification');

const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `enrich-ticket-platform-links.js — Enrich shows.json with Telecharge/Ticketmaster ticket links based on venue mapping.

Usage:
  node scripts/enrich-ticket-platform-links.js [options]
  node scripts/enrich-ticket-platform-links.js --help, -h    print this usage and exit
`;
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const DRY_RUN = process.argv.includes('--dry-run');

// ============================================================================
// Venue → Ticket Platform mapping (all 40 active Broadway theaters)
// ============================================================================

const VENUE_PLATFORM = {
  // Shubert Organization → Telecharge (except Broadway Theatre)
  'Ambassador Theatre': 'Telecharge',
  'Belasco Theatre': 'Telecharge',
  'Bernard B. Jacobs Theatre': 'Telecharge',
  'Booth Theatre': 'Telecharge',
  'Broadhurst Theatre': 'Telecharge',
  'Circle in the Square Theatre': 'Telecharge',
  'Ethel Barrymore Theatre': 'Telecharge',
  'Gerald Schoenfeld Theatre': 'Telecharge',
  'Imperial Theatre': 'Telecharge',
  'James Earl Jones Theatre': 'Telecharge',
  'John Golden Theatre': 'Telecharge',
  'Longacre Theatre': 'Telecharge',
  'Lyceum Theatre': 'Telecharge',
  'Majestic Theatre': 'Telecharge',
  'Music Box Theatre': 'Telecharge',
  'Samuel J. Friedman Theatre': 'Telecharge',
  'Shubert Theatre': 'Telecharge',
  'Winter Garden Theatre': 'Telecharge',

  // ATG Entertainment (ex-Jujamcyn) → mostly Telecharge
  'August Wilson Theatre': 'Telecharge',
  'Eugene O\'Neill Theatre': 'Telecharge',
  'Hudson Theatre': 'Telecharge',
  'Lyric Theatre': 'Telecharge',
  'St. James Theatre': 'Telecharge',
  'Walter Kerr Theatre': 'Telecharge',
  'Al Hirschfeld Theatre': 'Ticketmaster',  // ATG exception

  // Roundabout Theatre Company → Telecharge
  'Stephen Sondheim Theatre': 'Telecharge',
  'Todd Haimes Theatre': 'Telecharge',
  'Studio 54': 'Telecharge',

  // Manhattan Theatre Club → Telecharge
  // (Samuel J. Friedman already listed above)

  // Lincoln Center Theater → Telecharge
  'Vivian Beaumont Theater': 'Telecharge',

  // Second Stage → Telecharge
  'Helen Hayes Theater': 'Telecharge',

  // Nederlander Organization → Ticketmaster
  'Broadway Theatre': 'Ticketmaster',       // Shubert-owned but uses Ticketmaster
  'Gershwin Theatre': 'Ticketmaster',
  'Lena Horne Theatre': 'Ticketmaster',
  'Lunt-Fontanne Theatre': 'Ticketmaster',
  'Marquis Theatre': 'Ticketmaster',
  'Minskoff Theatre': 'Ticketmaster',
  'Nederlander Theatre': 'Ticketmaster',
  'Neil Simon Theatre': 'Ticketmaster',
  'Richard Rodgers Theatre': 'Ticketmaster',

  // Disney → Ticketmaster
  'New Amsterdam Theatre': 'Ticketmaster',
};

// ============================================================================
// Ticketmaster SERP discovery
// ============================================================================

function httpGet(url, options = {}) {
  return new Promise((resolve, reject) => {
    const timeout = options.timeout || 30000;
    const urlObj = new URL(url);
    const proto = urlObj.protocol === 'https:' ? https : require('http');
    const reqOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BroadwayScorecard/1.0)' },
      timeout,
    };
    const req = proto.request(reqOptions, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
      res.on('error', () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

/**
 * Generic SERP search — uses shared provider chain (BD first → SB fallback).
 * Returns array of organic results or null.
 */
async function serpSearch(query) {
  const results = await serpQuery(query);
  if (!results) return null;
  // Return in the format callers expect ({url, title, link} etc.)
  return results.map(r => ({ url: r.url, link: r.url, title: r.title || '' }));
}

/**
 * Match SERP results against a target domain with title verification.
 */
function matchSerpResult(results, targetDomain, showTitle, pathFilter) {
  for (const r of results) {
    const url = r.url || r.link;
    if (!url || !url.includes(targetDomain)) continue;
    // Skip search/listing pages
    if (url.includes('/search') || url.includes('/category') || url.includes('/discover')) continue;
    // Optional path filter
    if (pathFilter && !pathFilter(url)) continue;
    // Verify title match
    const serpTitle = normalizeShowName(r.title || '');
    const showNorm = normalizeShowName(showTitle);
    const primaryTitle = showTitle.includes(':') ? normalizeShowName(showTitle.split(':')[0]) : showNorm;
    const matched = [showNorm, primaryTitle].some(candidate => {
      const words = candidate.split(' ').filter(w => w.length > 2);
      const matchCount = words.filter(w => serpTitle.includes(w)).length;
      return words.length === 0 || matchCount >= Math.ceil(words.length * 0.5);
    });
    if (matched) {
      return url.replace(/^http:/, 'https:');
    }
  }
  return null;
}

/**
 * Discover Telecharge URL via SERP, falling back to deterministic construction.
 * Telecharge blocks all HTTP via Akamai, so SERP is the only verification method.
 */
async function discoverTelechargeUrl(showTitle) {
  const results = await serpSearch(`site:telecharge.com "${showTitle}" broadway`);
  if (results && results.length > 0) {
    const url = matchSerpResult(results, 'telecharge.com', showTitle);
    if (url) {
      console.log(`  SERP found: ${url}`);
      return url;
    }
  }
  // Fallback: deterministic URL construction
  const fallbackUrl = buildTelechargeUrl(showTitle);
  console.log(`  SERP miss → deterministic fallback: ${fallbackUrl}`);
  return fallbackUrl;
}

/**
 * Search for a show's Ticketmaster URL via SERP.
 * Uses allowlist of valid TM path patterns instead of strict regex.
 */
async function discoverTicketmasterUrl(showTitle) {
  const results = await serpSearch(`site:ticketmaster.com "${showTitle}" broadway tickets`);

  if (!results || results.length === 0) {
    console.log(`  ⚠ No SERP results for Ticketmaster`);
    return null;
  }

  // Allowlist of valid Ticketmaster path patterns
  const validPaths = ['/event/', '/artist/', '/venue/', '/tickets/'];
  const url = matchSerpResult(results, 'ticketmaster.com', showTitle, (u) => {
    return validPaths.some(p => u.includes(p));
  });

  if (url) {
    return url.replace('://ticketmaster.com', '://www.ticketmaster.com');
  }

  return null;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  // --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  console.log(`Ticket Platform Link Enrichment ${DRY_RUN ? '(DRY RUN)' : ''}`);
  console.log('='.repeat(60));

  const showsData = loadShows();
  const shows = showsData.shows;

  const open = shows.filter(s =>
    (s.status === 'open' || s.status === 'previews') &&
    isBroadwayCategory(s)
  );

  console.log(`Open/preview Broadway shows: ${open.length}\n`);

  let telechargeAdded = 0;
  let ticketmasterAdded = 0;
  let skippedNoVenue = 0;
  let skippedAlreadyHas = 0;

  for (const show of open) {
    const platform = VENUE_PLATFORM[show.venue];

    if (!platform) {
      console.log(`${show.id}: unknown venue "${show.venue}" — skipping`);
      skippedNoVenue++;
      continue;
    }

    // Check if show already has this platform link
    const links = show.ticketLinks || [];
    const hasPlatform = links.some(l => l.platform === platform);
    if (hasPlatform) {
      skippedAlreadyHas++;
      continue;
    }

    console.log(`${show.id}: ${show.venue} → ${platform}`);

    let url = null;

    if (platform === 'Telecharge') {
      url = await discoverTelechargeUrl(show.title);
    } else if (platform === 'Ticketmaster') {
      console.log(`  Searching SERP for Ticketmaster URL...`);
      url = await discoverTicketmasterUrl(show.title);
      if (url) {
        console.log(`  Found: ${url}`);
      } else {
        console.log(`  ✗ No Ticketmaster URL found via SERP`);
      }
      // Rate limit SERP calls
      await new Promise(r => setTimeout(r, 500));
    }

    if (url && !DRY_RUN) {
      if (!show.ticketLinks) show.ticketLinks = [];

      // Insert after TodayTix (first position if no TodayTix)
      const ttIndex = show.ticketLinks.findIndex(l => l.platform === 'TodayTix');
      const insertAt = ttIndex >= 0 ? ttIndex + 1 : show.ticketLinks.length;
      show.ticketLinks.splice(insertAt, 0, { platform, url, priceFrom: null });
    }

    if (url) {
      if (platform === 'Telecharge') telechargeAdded++;
      else ticketmasterAdded++;
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Results:`);
  console.log(`  Telecharge added: ${telechargeAdded}`);
  console.log(`  Ticketmaster added: ${ticketmasterAdded}`);
  console.log(`  Already had platform link: ${skippedAlreadyHas}`);
  console.log(`  Unknown venue (skipped): ${skippedNoVenue}`);

  if (!DRY_RUN && (telechargeAdded > 0 || ticketmasterAdded > 0)) {
    saveShows(showsData);
    console.log(`\nshows.json updated.`);
  } else if (DRY_RUN) {
    console.log(`\n(dry run — no files written)`);
  } else {
    console.log(`\nNo changes needed.`);
  }

  // GitHub Actions output
  if (process.env.GITHUB_OUTPUT) {
    const total = telechargeAdded + ticketmasterAdded;
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `changes_made=${total > 0}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `enriched=${total}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `summary=${telechargeAdded} Telecharge, ${ticketmasterAdded} Ticketmaster\n`);
  }
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
