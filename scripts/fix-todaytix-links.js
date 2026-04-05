#!/usr/bin/env node

/**
 * Automated TodayTix link fixer
 *
 * 1. Checks all TodayTix URLs in shows.json via HTTP HEAD (200 = ok, 404 = broken)
 * 2. For broken links on open/preview shows: queries TodayTix API to find the correct URL
 * 3. For broken links on closed shows: removes the stale link
 * 4. Detects wrong-show redirects by comparing <title> content
 *
 * TodayTix API: api.todaytix.com/api/v2/shows?query=NAME&location=1 (NYC) or location=2 (London)
 * URL pattern: todaytix.com/nyc/shows/{id}-{slug} or todaytix.com/london/shows/{id}-{slug}
 *
 * Usage: node scripts/fix-todaytix-links.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { isLondonMarket } = require('./lib/venue-classification');
const { buildTodayTixUrl, normalizeShowName } = require('./lib/url-utils');
const { cleanSearchTitle } = require('./lib/title-normalization');

const DRY_RUN = process.argv.includes('--dry-run');
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');

// Market-aware TodayTix configuration
function getTodayTixConfig(show) {
  const isWestEnd = isLondonMarket(show.category);
  return {
    location: isWestEnd ? 2 : 1,
    city: isWestEnd ? 'london' : 'nyc',
  };
}

function httpRequest(url, method = 'GET', options = {}) {
  return new Promise((resolve, reject) => {
    const timeout = options.timeout || 15000;
    const maxBytes = options.maxBytes || 0; // 0 = no limit
    const urlObj = new URL(url);
    const reqOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BroadwayScorecard/1.0)' },
      timeout,
    };

    const req = https.request(reqOptions, (res) => {
      // For HEAD requests, we only need status code
      if (method === 'HEAD') {
        res.resume(); // drain
        resolve({ statusCode: res.statusCode, headers: res.headers, body: '' });
        return;
      }

      let body = '';
      let bytesRead = 0;
      res.on('data', (chunk) => {
        bytesRead += chunk.length;
        body += chunk;
        // If we have enough data (e.g., just need <title>), stop reading
        if (maxBytes > 0 && bytesRead >= maxBytes) {
          res.destroy();
          resolve({ statusCode: res.statusCode, headers: res.headers, body });
        }
      });
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
      res.on('error', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

/**
 * Check if a TodayTix URL is valid by sending a HEAD request.
 * TodayTix returns proper 200/404 status codes.
 */
async function checkUrl(url) {
  try {
    const result = await httpRequest(url, 'HEAD');
    return result.statusCode;
  } catch (e) {
    return -1; // error
  }
}

/**
 * For 200 responses, read the first 100KB to check the page <title>.
 * Detects when TodayTix recycles a URL to point at a different show.
 */
async function getPageTitle(url) {
  try {
    const result = await httpRequest(url, 'GET', { maxBytes: 100000 });
    const match = result.body.match(/<title[^>]*>([^<]+)<\/title>/i);
    return match ? match[1].trim() : null;
  } catch (e) {
    return null;
  }
}

/**
 * Search TodayTix API for a show by name. Returns { id, slug, displayName } or null.
 */
async function searchTodayTixApi(showTitle, location = 1) {
  const query = encodeURIComponent(cleanSearchTitle(showTitle));
  const apiUrl = `https://api.todaytix.com/api/v2/shows?query=${query}&location=${location}`;

  try {
    const result = await httpRequest(apiUrl, 'GET');
    const json = JSON.parse(result.body);
    if (!json.data || json.data.length === 0) return null;

    // Find best match — prefer exact name match
    const normalizedTitle = normalizeShowName(showTitle);
    const exactMatch = json.data.find(s =>
      normalizeShowName(s.displayName) === normalizedTitle ||
      normalizeShowName(s.name || '') === normalizedTitle
    );

    if (exactMatch) {
      return { id: exactMatch.id, slug: exactMatch.slug, displayName: exactMatch.displayName };
    }

    // Fuzzy match: check if significant words from our title appear in the API result
    const ourWords = normalizedTitle.split(' ').filter(w => w.length > 2);
    for (const show of json.data) {
      const apiName = normalizeShowName(show.displayName);
      const matchCount = ourWords.filter(w => apiName.includes(w)).length;
      if (matchCount >= Math.ceil(ourWords.length * 0.6)) {
        return { id: show.id, slug: show.slug, displayName: show.displayName };
      }
    }

    return null;
  } catch (e) {
    console.log(`  API search failed: ${e.message}`);
    return null;
  }
}

/**
 * Check if a TodayTix page is showing the correct show by comparing titles.
 */
function isTitleMatch(pageTitle, expectedShowTitle) {
  if (!pageTitle) return true; // can't verify, assume ok
  const normalizedPage = normalizeShowName(pageTitle);
  const normalizedExpected = normalizeShowName(expectedShowTitle);
  const expectedWords = normalizedExpected.split(' ').filter(w => w.length > 2);
  if (expectedWords.length === 0) return true;
  const matchCount = expectedWords.filter(w => normalizedPage.includes(w)).length;
  return matchCount >= Math.ceil(expectedWords.length * 0.5);
}

async function main() {
  console.log(`TodayTix Link Checker ${DRY_RUN ? '(DRY RUN)' : ''}`);
  console.log('='.repeat(60));

  const data = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const shows = data.shows;

  // Collect all shows with TodayTix links
  const todaytixShows = [];
  for (let i = 0; i < shows.length; i++) {
    const show = shows[i];
    if (!show.ticketLinks) continue;
    const ttLink = show.ticketLinks.find(l => l.platform === 'TodayTix');
    if (ttLink) {
      todaytixShows.push({ index: i, show, link: ttLink });
    }
  }

  console.log(`Found ${todaytixShows.length} TodayTix links to check\n`);

  let fixed = 0;
  let removed = 0;
  let errors = 0;
  const broken = [];

  // Phase 1: Check all links with HEAD requests (fast)
  for (const entry of todaytixShows) {
    const { show, link } = entry;
    process.stdout.write(`Checking ${show.id}... `);

    const statusCode = await checkUrl(link.url);

    if (statusCode === 200) {
      // Check if the page is actually for the correct show (detect ID recycling)
      const pageTitle = await getPageTitle(link.url);
      if (pageTitle && !isTitleMatch(pageTitle, show.title)) {
        console.log(`WRONG SHOW (page shows: "${pageTitle}")`);
        broken.push({ ...entry, reason: 'wrong_show', detail: pageTitle });
      } else {
        console.log('OK');
      }
    } else if (statusCode === 404) {
      console.log('404');
      broken.push({ ...entry, reason: '404' });
    } else {
      console.log(`HTTP ${statusCode}`);
      broken.push({ ...entry, reason: 'error', detail: `HTTP ${statusCode}` });
    }

    // Small delay between requests
    await new Promise(r => setTimeout(r, 300));
  }

  if (broken.length === 0) {
    console.log('\nAll TodayTix links are working!');
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, 'changes_made=false\n');
      fs.appendFileSync(process.env.GITHUB_OUTPUT, 'summary=All links OK\n');
    }
    return;
  }

  // Phase 2: Fix broken links
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Found ${broken.length} broken links. Attempting fixes...\n`);

  for (const { show, link, reason, detail } of broken) {
    console.log(`${show.id} (${show.status}): ${reason}${detail ? ' — ' + detail : ''}`);
    console.log(`  Old URL: ${link.url}`);

    // For closed shows, just remove the broken link
    if (show.status === 'closed') {
      if (!DRY_RUN) {
        const ttIndex = show.ticketLinks.findIndex(l => l.platform === 'TodayTix');
        if (ttIndex >= 0) show.ticketLinks.splice(ttIndex, 1);
      }
      console.log('  -> REMOVED (show is closed)');
      removed++;
      continue;
    }

    // For open/preview shows, search the TodayTix API for the correct URL
    const ttConfig = getTodayTixConfig(show);
    console.log(`  Searching TodayTix API (${ttConfig.city})...`);
    const apiResult = await searchTodayTixApi(show.title, ttConfig.location);

    if (apiResult) {
      const newUrl = buildTodayTixUrl(apiResult.id, apiResult.slug, ttConfig.city);

      // Verify the new URL actually works
      const verifyStatus = await checkUrl(newUrl);
      if (verifyStatus === 200) {
        if (!DRY_RUN) {
          link.url = newUrl;
        }
        console.log(`  -> FIXED: ${newUrl} (matched: "${apiResult.displayName}")`);
        fixed++;
      } else {
        console.log(`  -> API found "${apiResult.displayName}" but URL returns ${verifyStatus}, removing`);
        if (!DRY_RUN) {
          const ttIndex = show.ticketLinks.findIndex(l => l.platform === 'TodayTix');
          if (ttIndex >= 0) show.ticketLinks.splice(ttIndex, 1);
        }
        removed++;
      }
    } else {
      console.log('  -> No match in TodayTix API, removing broken link');
      if (!DRY_RUN) {
        const ttIndex = show.ticketLinks.findIndex(l => l.platform === 'TodayTix');
        if (ttIndex >= 0) show.ticketLinks.splice(ttIndex, 1);
      }
      removed++;
    }

    // Delay between API calls
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Results: ${fixed} fixed, ${removed} removed, ${errors} unresolved`);

  if (!DRY_RUN && (fixed > 0 || removed > 0)) {
    fs.writeFileSync(SHOWS_PATH, JSON.stringify(data, null, 2) + '\n');
    console.log('Saved shows.json');
  }

  // Set output for GitHub Actions
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `changes_made=${fixed + removed > 0}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `fixed=${fixed}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `removed=${removed}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `summary=${fixed} fixed, ${removed} removed, ${errors} unresolved\n`);
  }
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
