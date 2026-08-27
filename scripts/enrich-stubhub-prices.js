#!/usr/bin/env node
/**
 * Enrich ticketLinks[].priceFrom for StubHub entries from page scraping.
 *
 * Fetches each StubHub performer/category page via Bright Data,
 * extracts lowPrice values from embedded JSON-LD/state, takes the minimum.
 *
 * Usage: node scripts/enrich-stubhub-prices.js [--dry-run] [--limit N]
 *
 * Requires: BRIGHTDATA_TOKEN (or SCRAPINGBEE_API_KEY as fallback)
 */

const fs = require('fs');
const path = require('path');
const { fetchPage, cleanup } = require('./lib/scraper');
const { loadShows, saveShows } = require('./lib/shows-write-guard');

const { hasHelpFlag } = require('./lib/cli-help.js');
const { parseTimeBudgetMin, createRunBudget } = require('./lib/run-budget');

const USAGE = `enrich-stubhub-prices.js — Enrich ticketLinks[].priceFrom for StubHub entries from page scraping.

Usage:
  node scripts/enrich-stubhub-prices.js [options]
  node scripts/enrich-stubhub-prices.js --help, -h    print this usage and exit

Options:
  --time-budget-min=N  wall-clock budget in minutes (0/omitted = unlimited)
`;
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT = (() => {
  const idx = process.argv.indexOf('--limit');
  return idx > -1 ? parseInt(process.argv[idx + 1], 10) : Infinity;
})();
const timeBudget = createRunBudget(parseTimeBudgetMin(process.argv.slice(2)));

function extractMinPrice(html) {
  // StubHub embeds lowPrice in JSON-LD and page state across event listings
  const matches = [...html.matchAll(/"lowPrice"[:\s]*"?([0-9.]+)/g)];
  const prices = matches.map(m => parseFloat(m[1])).filter(p => p > 0 && p < 5000);
  if (prices.length === 0) return null;
  return Math.ceil(Math.min(...prices)); // Round up to nearest dollar
}

async function main() {
  // --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const showsData = loadShows();
  const shows = showsData.shows;

  // Find open/previews shows with StubHub links
  const candidates = shows.filter(s =>
    (s.status === 'open' || s.status === 'previews') &&
    s.ticketLinks?.some(l => l.platform === 'StubHub')
  );

  console.log(`StubHub-linked open shows: ${candidates.length}`);
  console.log(`DRY_RUN: ${DRY_RUN}, LIMIT: ${LIMIT === Infinity ? 'none' : LIMIT}\n`);

  let updated = 0;
  let skipped = 0;
  let failed = 0;
  let consecutiveFailures = 0;
  const MAX_CONSECUTIVE_FAILURES = 5;
  const toProcess = candidates.slice(0, LIMIT);

  for (let i = 0; i < toProcess.length; i++) {
    if (timeBudget.exceeded()) {
      console.log(`\n⏱ Time budget (${timeBudget.minutes} min) reached — ${toProcess.length - i} show(s) deferred to next run.`);
      break;
    }
    const show = toProcess[i];
    const shLink = show.ticketLinks.find(l => l.platform === 'StubHub');
    if (!shLink?.url) continue;

    try {
      console.log(`[${i + 1}/${toProcess.length}] ${show.id}...`);
      const result = await fetchPage(shLink.url);
      const html = typeof result === 'string' ? result : result?.content || '';

      if (!html || html.length < 1000) {
        console.log(`  ⚠ Empty or blocked response (${html.length} bytes)`);
        failed++;
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.log(`\n⚠ ${MAX_CONSECUTIVE_FAILURES} consecutive failures — scraping provider likely down. Aborting early.`);
          break;
        }
        continue;
      }

      const price = extractMinPrice(html);
      if (price == null) {
        console.log(`  ⚠ No prices found in page`);
        failed++;
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.log(`\n⚠ ${MAX_CONSECUTIVE_FAILURES} consecutive failures — scraping provider likely down. Aborting early.`);
          break;
        }
        continue;
      }
      consecutiveFailures = 0; // Reset on success

      if (shLink.priceFrom === price) {
        console.log(`  → $${price} (unchanged)`);
        skipped++;
        continue;
      }

      const old = shLink.priceFrom;
      if (!DRY_RUN) {
        shLink.priceFrom = price;
      }
      updated++;
      console.log(`  → ${old ?? 'null'} → $${price}`);

      // Rate limit: 2s between requests
      if (i < toProcess.length - 1) {
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch (e) {
      console.log(`  ✗ Error: ${e.message}`);
      failed++;
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.log(`\n⚠ ${MAX_CONSECUTIVE_FAILURES} consecutive failures — scraping provider likely down. Aborting early.`);
        break;
      }
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Updated: ${updated}`);
  console.log(`Unchanged: ${skipped}`);
  console.log(`Failed: ${failed}`);

  if (!DRY_RUN && updated > 0) {
    saveShows(showsData);
    console.log(`\nshows.json updated.`);
  } else if (DRY_RUN) {
    console.log(`\n(dry run — no files written)`);
  } else {
    console.log(`\nNo changes needed.`);
  }
}

main()
  .catch(e => { console.error(e); process.exitCode = 1; })
  .finally(() => {
    // A successful Playwright fetch leaves Chromium open — cleanup() closes
    // it with a timeout guard (#438/#914 class).
    cleanup().catch(() => {}).finally(() => process.exit(process.exitCode || 0));
  });
