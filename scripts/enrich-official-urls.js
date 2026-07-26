#!/usr/bin/env node
/**
 * Enrich shows.json with official website URLs via SERP discovery.
 *
 * For shows missing `officialUrl`, searches Google for the show's official website,
 * filters out ticket platforms/review sites/social media, and sets the URL if a
 * high-confidence match is found.
 *
 * Usage:
 *   node scripts/enrich-official-urls.js [--dry-run] [--category=broadway|off-broadway|west-end] [--time-budget-min=N]
 *
 * --time-budget-min=N: wall-clock budget in minutes (0 or omitted = unlimited).
 * Exits cleanly once exceeded instead of running into the job timeout;
 * deferred shows are picked up on the next run. Runs last in a 25-min job
 * shared with fix-platform-ticket-links.js, so this also protects against
 * that earlier step eating most of the shared budget.
 *
 * Requires: SCRAPINGBEE_API_KEY env var for SERP access.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { serpQuery } = require('./lib/url-discovery');
const { isLondonMarket } = require('./lib/venue-classification');
const { loadShows, saveShows } = require('./lib/shows-write-guard');
const { parseTimeBudgetMin, createRunBudget } = require('./lib/run-budget');
const { hasHelpFlag } = require('./lib/cli-help');

const USAGE = `enrich-official-urls.js — Enrich shows.json with official website URLs via SERP discovery.

Usage:
  node scripts/enrich-official-urls.js [--dry-run] [--category=broadway|off-broadway|west-end] [--time-budget-min=N]
  node scripts/enrich-official-urls.js --help, -h    print this usage and exit
`;

const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const DRY_RUN = process.argv.includes('--dry-run');
const CATEGORY_ARG = process.argv.find(a => a.startsWith('--category='));
const CATEGORY_FILTER = CATEGORY_ARG ? CATEGORY_ARG.split('=')[1] : null;
const timeBudget = createRunBudget(parseTimeBudgetMin(process.argv.slice(2)));

// ============================================================================
// Domain blocklist — never treat these as official show sites
// ============================================================================

const BLOCKED_DOMAINS = new Set([
  // Ticket platforms
  'todaytix.com', 'telecharge.com', 'ticketmaster.com', 'broadwaydirect.com',
  'seatgeek.com', 'stubhub.com', 'vividseats.com', 'broadwaybox.com',
  'goldstar.com', 'headout.com', 'rush.app',
  // Theater/review sites
  'playbill.com', 'broadwayworld.com', 'broadway.com', 'ibdb.com',
  'theatermania.com', 'showscore.com', 'whatsonstage.com',
  'broadwayhd.com', 'bwayrush.com', 'nytimes.com', 'variety.com',
  'hollywoodreporter.com', 'vulture.com', 'timeout.com', 'theguardian.com',
  'nypost.com', 'deadline.com', 'ew.com', 'usatoday.com', 'apnews.com',
  'washingtonpost.com', 'wsj.com', 'latimes.com',
  // Reference/social
  'wikipedia.org', 'wikidata.org', 'imdb.com',
  'facebook.com', 'instagram.com', 'twitter.com', 'x.com',
  'youtube.com', 'tiktok.com', 'reddit.com', 'threads.net',
  // Generic
  'yelp.com', 'tripadvisor.com', 'google.com', 'amazon.com',
  'pinterest.com', 'linkedin.com', 'tumblr.com',
  // Theater listing/guide sites (not show-specific)
  'broadway.org', 'newyorktheatreguide.com', 'theatreaccess.nyc', 'nystagereview.com',
  'newyorktheater.me', 'theatrely.com', 'stagebuddy.com',
  'londontheatre.co.uk', 'thestage.co.uk', 'broadwaybox.com',
  // Event listing sites
  'donyc.com', 'eventbrite.com', 'dice.fm', 'songkick.com',
  // Licensing/production companies (not individual show sites)
  'concordtheatricals.com', 'mtishows.com', 'samuelfrench.com',
  'dramatists.com', 'tamswitmark.com',
  // Theater/venue sites (not show-specific)
  'shubert.nyc', 'nederlander.com', 'roundabouttheatre.org', 'lct.org',
  'manhattantheatreclub.com', '2st.com', 'nytw.org', 'publictheater.org',
  'signaturetheatre.org', 'mintheatre.org', 'atlantictheater.org',
  'classicstage.org', 'irishrep.org', 'newworldstages.com',
  // City/government/tourism sites
  'cityofwhiteplains.com', 'nyc.gov', 'nyctourism.com',
  // Our own site and other aggregators
  'broadwayscorecard.com', 'exeuntnyc.com', 'stageandcinema.com',
  'ticketnews.com', 'seatplan.com', 'newyorkcitytheatre.com',
  'masterworksbroadway.com', 'filmedlivemusicals.com',
  'broadwayacrossamerica.com', 'broadway.org.uk',
  'londonsbroadwaybuzz.ca',
]);

// ============================================================================
// SERP search
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

function httpHead(url) {
  return new Promise((resolve) => {
    try {
      const urlObj = new URL(url);
      const proto = urlObj.protocol === 'https:' ? https : require('http');
      const reqOptions = {
        hostname: urlObj.hostname,
        path: urlObj.pathname + urlObj.search,
        method: 'HEAD',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BroadwayScorecard/1.0)' },
        timeout: 10000,
      };
      const req = proto.request(reqOptions, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', () => resolve(-1));
      req.on('timeout', () => { req.destroy(); resolve(-1); });
      req.end();
    } catch {
      resolve(-1);
    }
  });
}

function normalizeShowName(name) {
  return name.toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function isBlockedDomain(url) {
  const domain = getDomain(url);
  for (const blocked of BLOCKED_DOMAINS) {
    if (domain === blocked || domain.endsWith('.' + blocked)) return true;
  }
  return false;
}

/**
 * Build a market-appropriate SERP query for finding a show's official site.
 */
function buildSearchQuery(show) {
  const cat = show.category || 'broadway';
  const market = isLondonMarket(cat) ? 'west end' : 'broadway';

  // For short/common titles, add disambiguators
  const words = show.title.split(/\s+/).filter(w => w.length > 2);
  const needsDisambig = words.length <= 2;

  const type = show.type === 'Musical' ? 'musical' : (show.type === 'Play' ? 'play' : '');

  if (needsDisambig && type) {
    return `"${show.title}" ${market} ${type} official website`;
  }
  return `"${show.title}" ${market} official website`;
}

/**
 * Check if a SERP result looks like a dedicated show website.
 * Prefer domains that contain the show name or common patterns.
 */
function scoreCandidate(url, serpTitle, showTitle) {
  const domain = getDomain(url);
  const showNorm = normalizeShowName(showTitle);
  // Try both full title and primary title (before colon/subtitle) to avoid
  // subtitle words diluting match ratio for short primary names
  const primaryTitle = showTitle.includes(':') ? normalizeShowName(showTitle.split(':')[0]) : showNorm;
  const wordSets = [showNorm, primaryTitle].map(t => t.split(' ').filter(w => w.length > 2));
  let score = 0;

  // Domain contains show name words (strong signal)
  const domainNorm = domain.replace(/[.-]/g, '');
  const domainMatches = wordSets.some(words => {
    const matchCount = words.filter(w => domainNorm.includes(w)).length;
    return words.length > 0 && matchCount >= Math.ceil(words.length * 0.5);
  });
  if (domainMatches) {
    score += 3;
  }

  // Common official site domain patterns
  if (domain.match(/broadway|musical|theplay|theshow|onstage|onbroadway/)) score += 1;
  if (domain.endsWith('.com')) score += 1;

  // SERP title contains show name
  const titleNorm = normalizeShowName(serpTitle || '');
  const titleMatches = wordSets.some(words => {
    const matchCount = words.filter(w => titleNorm.includes(w)).length;
    return words.length > 0 && matchCount >= Math.ceil(words.length * 0.5);
  });
  if (titleMatches) {
    score += 2;
  }

  // SERP title says "official" (strong signal)
  if (titleNorm.includes('official')) score += 2;

  return score;
}

async function discoverOfficialUrl(show) {
  const query = buildSearchQuery(show);

  try {
    const results = await serpQuery(query);
    if (!results) return null;

    // Score and filter candidates
    const candidates = [];
    for (const r of results) {
      const url = r.url;
      if (!url) continue;
      if (isBlockedDomain(url)) continue;

      const s = scoreCandidate(url, r.title || '', show.title);
      // Off-Broadway shows need higher threshold — many don't have dedicated
      // websites, so SERP returns listing/review sites as false positives
      const cat = show.category || 'broadway';
      const threshold = cat === 'off-broadway' ? 5 : 3;
      if (s >= threshold) {
        candidates.push({ url, title: r.title, score: s });
      }
    }

    if (candidates.length === 0) return null;

    // Take highest-scoring candidate
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];

    // HEAD verify the URL is reachable
    const status = await httpHead(best.url);
    if (status >= 200 && status < 400) {
      return best.url;
    }

    console.log(`  ⚠ Best candidate returned HTTP ${status}: ${best.url}`);
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
  // --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }

  console.log(`Official URL Enrichment ${DRY_RUN ? '(DRY RUN)' : ''}`);
  if (CATEGORY_FILTER) console.log(`Category filter: ${CATEGORY_FILTER}`);
  console.log('='.repeat(60));

  if (!process.env.SCRAPINGBEE_API_KEY) {
    console.log('⚠ SCRAPINGBEE_API_KEY not set — cannot perform SERP searches');
    console.log('Set the env var and re-run.');
    return;
  }

  const showsData = loadShows();
  const shows = showsData.shows;

  const targets = shows.filter(s => {
    if (s.status !== 'open' && s.status !== 'previews') return false;
    if (s.officialUrl) return false;
    const cat = s.category || 'broadway';
    if (CATEGORY_FILTER && cat !== CATEGORY_FILTER) return false;
    return true;
  });

  console.log(`Shows missing officialUrl: ${targets.length}\n`);

  let found = 0;
  let notFound = 0;
  let budgetExit = false;

  for (const show of targets) {
    // Each show's discoverOfficialUrl() runs a SERP chain — this loop runs
    // last in a 25-min job shared with fix-platform-ticket-links.js, so an
    // unbounded catalog-wide list (currently dormant for broadway-only
    // dispatch, but not bounded by design) could run past the job's
    // timeout-minutes with nothing committed (same class as #369/#415).
    if (timeBudget.exceeded()) {
      budgetExit = true;
      console.log(`⏱ Time budget (${timeBudget.minutes} min) reached — remaining shows deferred to next run.`);
      break;
    }

    process.stdout.write(`${show.id}: `);
    const url = await discoverOfficialUrl(show);

    if (url) {
      console.log(`✓ ${url}`);
      if (!DRY_RUN) show.officialUrl = url;
      found++;
    } else {
      console.log('✗ no match');
      notFound++;
    }

    // Rate limit SERP calls
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Results: ${found} found, ${notFound} not found${budgetExit ? ' (time budget exit)' : ''}`);

  if (!DRY_RUN && found > 0) {
    saveShows(showsData);
    console.log('shows.json updated.');
  } else if (DRY_RUN) {
    console.log('(dry run — no files written)');
  } else {
    console.log('No changes needed.');
  }

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `changes_made=${found > 0}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `enriched=${found}\n`);
  }
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
