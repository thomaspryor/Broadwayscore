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
const { fetchPage } = require('./lib/scraper');

const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT = (() => {
  const idx = process.argv.indexOf('--limit');
  return idx > -1 ? parseInt(process.argv[idx + 1], 10) : Infinity;
})();

function extractMinPrice(html) {
  // StubHub embeds lowPrice in JSON-LD and page state across event listings
  const matches = [...html.matchAll(/"lowPrice"[:\s]*"?([0-9.]+)/g)];
  const prices = matches.map(m => parseFloat(m[1])).filter(p => p > 0 && p < 5000);
  if (prices.length === 0) return null;
  return Math.ceil(Math.min(...prices)); // Round up to nearest dollar
}

async function main() {
  const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
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
  const toProcess = candidates.slice(0, LIMIT);

  for (let i = 0; i < toProcess.length; i++) {
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
        continue;
      }

      const price = extractMinPrice(html);
      if (price == null) {
        console.log(`  ⚠ No prices found in page`);
        failed++;
        continue;
      }

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
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Updated: ${updated}`);
  console.log(`Unchanged: ${skipped}`);
  console.log(`Failed: ${failed}`);

  if (!DRY_RUN && updated > 0) {
    fs.writeFileSync(SHOWS_PATH, JSON.stringify(showsData, null, 2) + '\n');
    console.log(`\nshows.json updated.`);
  } else if (DRY_RUN) {
    console.log(`\n(dry run — no files written)`);
  } else {
    console.log(`\nNo changes needed.`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
