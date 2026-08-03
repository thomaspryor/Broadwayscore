#!/usr/bin/env node
/**
 * Backfill missing IBDB URLs for shows with Tony nominations.
 *
 * Finds cast files where ibdbUrl is null but the show has Tony data in awards.json.
 * Uses searchIBDB() (Google SERP via ScrapingBee) to find the correct IBDB production URL.
 * Validates found URLs by cross-referencing opening year to prevent wrong-production matches.
 *
 * Usage:
 *   node scripts/backfill-ibdb-urls.js [--dry-run]
 *
 * Requires: SCRAPINGBEE_API_KEY in environment (or .env file)
 */

const fs = require('fs');
const path = require('path');
const { searchIBDB } = require('./lib/ibdb-dates');

// Load .env if available
require('./lib/load-env').loadEnv();

const AWARDS_FILE = path.join(__dirname, '..', 'data', 'awards.json');
const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');
const CAST_DIR = path.join(__dirname, '..', 'data', 'cast');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  if (dryRun) console.log('DRY RUN -- no files will be modified\n');

  // Load data
  const awardsData = JSON.parse(fs.readFileSync(AWARDS_FILE, 'utf8'));
  const showsData = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
  const showsMap = new Map(showsData.shows.map(s => [s.id, s]));

  // Find shows with Tony noms but no IBDB URL
  const needsUrl = [];
  const showIds = Object.keys(awardsData.shows).filter(id => {
    const show = awardsData.shows[id];
    return show.tony && show.tony.nominations > 0;
  });

  for (const id of showIds) {
    const castFile = path.join(CAST_DIR, id + '.json');
    if (!fs.existsSync(castFile)) {
      needsUrl.push({ id, reason: 'no-cast-file' });
      continue;
    }
    const cast = JSON.parse(fs.readFileSync(castFile, 'utf8'));
    if (!cast.ibdbUrl) {
      needsUrl.push({ id, reason: 'no-ibdb-url', castFile });
    }
  }

  console.log(`Found ${needsUrl.length} shows needing IBDB URLs\n`);

  let found = 0;
  let notFound = 0;
  let rejected = 0;
  let noCastFile = 0;

  for (let i = 0; i < needsUrl.length; i++) {
    const { id, reason, castFile } = needsUrl[i];

    if (reason === 'no-cast-file') {
      console.log(`[${i + 1}/${needsUrl.length}] ${id} -- no cast file, skipping`);
      noCastFile++;
      continue;
    }

    const show = showsMap.get(id);
    if (!show) {
      console.log(`[${i + 1}/${needsUrl.length}] ${id} -- not in shows.json, skipping`);
      notFound++;
      continue;
    }

    const title = show.title;
    const openingYear = show.openingDate ? parseInt(show.openingDate.split('-')[0]) : null;

    console.log(`[${i + 1}/${needsUrl.length}] ${id} -- "${title}" (${openingYear || '?'})`);

    const results = await searchIBDB(title, { openingYear });

    if (results.length === 0) {
      console.log(`  No IBDB URL found\n`);
      notFound++;
    } else {
      const best = results[0];

      // Year validation: check if the found URL's year matches our show's opening year
      let yearValid = true;
      if (openingYear && best.year) {
        const urlYear = parseInt(best.year);
        if (Math.abs(urlYear - openingYear) > 2) {
          console.log(`  REJECTED: URL year ${best.year} differs from show year ${openingYear} by >2 years`);
          console.log(`    URL: ${best.url}`);
          console.log(`    This is likely a different production (revival vs original)\n`);
          rejected++;
          yearValid = false;
        }
      }

      if (yearValid) {
        console.log(`  Found: ${best.url}`);
        if (dryRun) {
          console.log(`    (dry run -- would update ${castFile})\n`);
        } else {
          const cast = JSON.parse(fs.readFileSync(castFile, 'utf8'));
          cast.ibdbUrl = best.url;
          fs.writeFileSync(castFile, JSON.stringify(cast, null, 2));
          console.log(`    Updated ${path.basename(castFile)}\n`);
        }
        found++;
      }
    }

    // Rate limit between SERP calls
    if (i < needsUrl.length - 1) {
      await sleep(2000);
    }
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`  Found & updated: ${found}`);
  console.log(`  Not found:       ${notFound}`);
  console.log(`  Rejected (wrong year): ${rejected}`);
  console.log(`  No cast file:    ${noCastFile}`);
  console.log(`  Total:           ${needsUrl.length}`);

  if (dryRun) {
    console.log(`\n(This was a dry run -- re-run without --dry-run to apply changes)`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
