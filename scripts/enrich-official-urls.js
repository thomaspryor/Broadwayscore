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
const { loadShows, saveShows } = require('./lib/shows-write-guard');
const { parseTimeBudgetMin, createRunBudget } = require('./lib/run-budget');
const { hasHelpFlag } = require('./lib/cli-help');
const { discoverOfficialUrl: discoverOfficialUrlBase } = require('./lib/official-url-discovery');

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

// Domain blocklist, scoring, and the discovery algorithm itself live in
// scripts/lib/official-url-discovery.js (shared with ob-discovery-ticket-links.js,
// BRO-166).
const discoverOfficialUrl = discoverOfficialUrlBase;

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
