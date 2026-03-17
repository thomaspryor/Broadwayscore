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
const { buildTelechargeUrl, normalizeShowName } = require('./lib/url-utils');

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
 * Search for a show's Ticketmaster URL via ScrapingBee SERP API.
 * Returns a URL matching ticketmaster.com/.../artist/\d+ or null.
 */
async function discoverTicketmasterUrl(showTitle) {
  const apiKey = process.env.SCRAPINGBEE_API_KEY;
  if (!apiKey) {
    console.log('  ⚠ SCRAPINGBEE_API_KEY not set — skipping Ticketmaster SERP');
    return null;
  }

  const query = `site:ticketmaster.com "${showTitle}" broadway tickets`;
  const searchUrl = `https://app.scrapingbee.com/api/v1/store/google?api_key=${apiKey}&search=${encodeURIComponent(query)}`;

  try {
    const result = await httpGet(searchUrl);
    if (result.statusCode !== 200) {
      console.log(`  ⚠ SERP returned ${result.statusCode}`);
      return null;
    }
    const data = JSON.parse(result.body);
    const results = data.organic_results || data.results || [];

    // Find a result matching the Ticketmaster artist URL pattern
    const tmPattern = /ticketmaster\.com\/.*tickets\/artist\/\d+/;
    for (const r of results) {
      const url = r.url || r.link;
      if (!url || !tmPattern.test(url)) continue;

      // Verify the SERP title matches our show
      // Try both full title and primary title (before colon/subtitle) — subtitles
      // dilute word-match ratio for short primary names like "All Out"
      const serpTitle = normalizeShowName(r.title || '');
      const showNorm = normalizeShowName(showTitle);
      const primaryTitle = showTitle.includes(':') ? normalizeShowName(showTitle.split(':')[0]) : showNorm;
      const candidates = [showNorm, primaryTitle];
      const matched = candidates.some(candidate => {
        const words = candidate.split(' ').filter(w => w.length > 2);
        const matchCount = words.filter(w => serpTitle.includes(w)).length;
        return words.length === 0 || matchCount >= Math.ceil(words.length * 0.5);
      });

      if (matched) {
        // Normalize to HTTPS www
        const cleanUrl = url.replace(/^http:/, 'https:').replace('://ticketmaster.com', '://www.ticketmaster.com');
        return cleanUrl;
      }
    }

    return null;
  } catch (e) {
    console.log(`  ⚠ SERP error: ${e.message}`);
    return null;
  }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  console.log(`Ticket Platform Link Enrichment ${DRY_RUN ? '(DRY RUN)' : ''}`);
  console.log('='.repeat(60));

  const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const shows = showsData.shows;

  const open = shows.filter(s =>
    (s.status === 'open' || s.status === 'previews') &&
    (s.category || 'broadway') === 'broadway'
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
      url = buildTelechargeUrl(show.title);
      console.log(`  Constructed: ${url}`);
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
    fs.writeFileSync(SHOWS_PATH, JSON.stringify(showsData, null, 2) + '\n');
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
