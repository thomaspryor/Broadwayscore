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
const { cronHttpRequest: httpRequest } = require('./cron-http-request');
const { createRunBudget, parseTimeBudgetMin } = require('./run-budget');
const { isLondonMarket } = require('./venue-classification');
const { buildTodayTixUrl, normalizeShowName } = require('./url-utils');
const { cleanSearchTitle } = require('./title-normalization');
const { loadShows, saveShows } = require('./shows-write-guard');

const { hasHelpFlag } = require('./cli-help.js');

const USAGE = `fix-todaytix-links.js: Automated TodayTix link fixer.

Usage:
  node scripts/fix-todaytix-links.js [--dry-run] [--time-budget-min=N]
  Default run budget: 20 minutes (15 minutes scanning, then repairs).
  node scripts/fix-todaytix-links.js --help, -h    print this usage and exit
`;
const DRY_RUN = process.argv.includes('--dry-run');

// Market-aware TodayTix configuration
function getTodayTixConfig(show) {
  const isWestEnd = isLondonMarket(show.category);
  return {
    location: isWestEnd ? 2 : 1,
    city: isWestEnd ? 'london' : 'nyc',
  };
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
    if (result.statusCode !== 200) throw new Error(`HTTP ${result.statusCode}`);
    const json = JSON.parse(result.body);
    if (!Array.isArray(json.data)) throw new Error('Invalid TodayTix API response');
    if (json.data.length === 0) return null;

    // Find best match: prefer exact name match
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
    return undefined; // transient failure, keep the current link
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

async function main(options = {}) {
  const dryRun = options.dryRun ?? DRY_RUN;
  // Defaults apply to the existing weekly caller without a workflow edit.
  const budget = options.budget || createRunBudget(parseTimeBudgetMin(process.argv.slice(2)) || 20);
  const scanBudget = options.scanBudget || createRunBudget(Math.min(15, budget.minutes || 15));
  const checkLink = options.checkUrl || checkUrl;
  const readTitle = options.getPageTitle || getPageTitle;
  const search = options.searchTodayTixApi || searchTodayTixApi;
  const pause = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const save = options.saveShows || saveShows;
  // --help/-h checked before any real work (cousin of #260/#263/#264/#266: see scripts/lib/cli-help.js).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  console.log(`TodayTix Link Checker ${dryRun ? '(DRY RUN)' : ''}`);
  console.log('='.repeat(60));

  const data = options.data || loadShows();
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

  // Rotate the weekly starting point so a slow prefix cannot starve the tail.
  const offset = todaytixShows.length ? (Math.floor((options.now || Date.now)() / (7 * 86400000)) * 97) % todaytixShows.length : 0;
  todaytixShows.push(...todaytixShows.splice(0, offset));
  console.log(`Found ${todaytixShows.length} TodayTix links to check\n`);

  let fixed = 0;
  let removed = 0;
  let errors = 0;
  const broken = [];
  let checked = 0;
  let deferred = 0;

  // Phase 1: Check all links with HEAD requests (fast)
  for (const entry of todaytixShows) {
    if (scanBudget.exceeded() || budget.exceeded()) {
      deferred += todaytixShows.length - checked;
      console.log(`Scan budget reached; ${todaytixShows.length - checked} links deferred to a later run.`);
      break;
    }
    checked++;
    const { show, link } = entry;
    process.stdout.write(`Checking ${show.id}... `);

    const statusCode = await checkLink(link.url);

    if (statusCode === 200) {
      // Check if the page is actually for the correct show (detect ID recycling)
      const pageTitle = await readTitle(link.url);
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
      errors++; // A network error is not evidence of a broken link.
    }

    // Small delay between requests
    await pause(300);
  }

  if (broken.length === 0) {
    console.log(`\nResults: 0 fixed, 0 removed, ${errors} unresolved, ${deferred} deferred`);
    if (process.env.GITHUB_OUTPUT) {
      fs.appendFileSync(process.env.GITHUB_OUTPUT, 'changes_made=false\n');
      fs.appendFileSync(process.env.GITHUB_OUTPUT, `summary=0 fixed, 0 removed, ${errors} unresolved, ${deferred} deferred\n`);
    }
    return { fixed, removed, errors, deferred, checked };
  }

  // Phase 2: Fix broken links
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Found ${broken.length} broken links. Attempting fixes...\n`);

  let repaired = 0;
  for (const { show, link, reason, detail } of broken) {
    if (budget.exceeded()) {
      deferred += broken.length - repaired;
      console.log(`Run budget reached; ${broken.length - repaired} repairs deferred to a later run.`);
      break;
    }
    repaired++;
    console.log(`${show.id} (${show.status}): ${reason}${detail ? ': ' + detail : ''}`);
    console.log(`  Old URL: ${link.url}`);

    // For closed shows, just remove the broken link
    if (show.status === 'closed') {
      if (!dryRun) {
        const ttIndex = show.ticketLinks.findIndex(l => l.platform === 'TodayTix');
        if (ttIndex >= 0) show.ticketLinks.splice(ttIndex, 1);
      }
      console.log('  -> REMOVED (show is closed)');
      removed++;
      if (!dryRun) save(data);
      continue;
    }

    // For open/preview shows, search the TodayTix API for the correct URL
    const ttConfig = getTodayTixConfig(show);
    console.log(`  Searching TodayTix API (${ttConfig.city})...`);
    const apiResult = await search(show.title, ttConfig.location);

    if (apiResult === undefined) {
      console.log('  -> API unavailable, keeping link for retry');
      errors++;
      continue;
    }
    if (apiResult) {
      const newUrl = buildTodayTixUrl(apiResult.id, apiResult.slug, ttConfig.city);

      // Verify the new URL actually works
      const verifyStatus = await checkLink(newUrl);
      if (verifyStatus === 200) {
        if (!dryRun) {
          link.url = newUrl;
        }
        console.log(`  -> FIXED: ${newUrl} (matched: "${apiResult.displayName}")`);
        fixed++;
      } else if (verifyStatus === 404) {
        console.log(`  -> API found "${apiResult.displayName}" but URL returns ${verifyStatus}, removing`);
        if (!dryRun) {
          const ttIndex = show.ticketLinks.findIndex(l => l.platform === 'TodayTix');
          if (ttIndex >= 0) show.ticketLinks.splice(ttIndex, 1);
        }
        removed++;
      } else {
        console.log(`  -> Verification HTTP ${verifyStatus}, keeping link for retry`);
        errors++;
        continue;
      }
    } else {
      console.log('  -> No match in TodayTix API, removing broken link');
      if (!dryRun) {
        const ttIndex = show.ticketLinks.findIndex(l => l.platform === 'TodayTix');
        if (ttIndex >= 0) show.ticketLinks.splice(ttIndex, 1);
      }
      removed++;
    }

    // Delay between API calls
    if (!dryRun) save(data);
    await pause(500);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Results: ${fixed} fixed, ${removed} removed, ${errors} unresolved, ${deferred} deferred`);

  if (!dryRun && (fixed > 0 || removed > 0)) {
    console.log('Checkpointed shows.json');
  }

  // Set output for GitHub Actions
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `changes_made=${fixed + removed > 0}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `fixed=${fixed}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `removed=${removed}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `summary=${fixed} fixed, ${removed} removed, ${errors} unresolved, ${deferred} deferred\n`);
  }
  return { fixed, removed, errors, deferred, checked };
}

module.exports = { main, checkUrl, getPageTitle, searchTodayTixApi };

