#!/usr/bin/env node
/**
 * Enrich ticketLinks[].priceFrom from TodayTix API.
 *
 * Reads todaytixId from each show, looks up lowPriceForRegularTickets
 * in the bulk TodayTix API response, and sets priceFrom on the
 * matching TodayTix ticketLinks entry.
 *
 * Usage: node scripts/enrich-ticket-prices.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const DRY_RUN = process.argv.includes('--dry-run');

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Failed to parse JSON from ${url}`)); }
      });
    }).on('error', reject);
  });
}

async function fetchAllTodayTixShows(location) {
  const city = location === 1 ? 'NYC' : 'London';
  const allShows = [];
  let offset = 0;
  while (true) {
    const url = `https://api.todaytix.com/api/v2/shows?location=${location}&limit=100&offset=${offset}`;
    console.log(`Fetching TodayTix ${city} offset=${offset}...`);
    const data = await fetchJson(url);
    if (!data.data || data.data.length === 0) break;
    allShows.push(...data.data);
    offset += 100;
    if (data.data.length < 100) break;
    await new Promise(r => setTimeout(r, 500));
  }
  console.log(`  → ${allShows.length} shows from ${city}`);
  return allShows;
}

async function main() {
  const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const shows = showsData.shows;

  console.log(`Total shows in shows.json: ${shows.length}`);
  console.log(`DRY_RUN: ${DRY_RUN}\n`);

  // Fetch all TodayTix shows from both markets
  const nycShows = await fetchAllTodayTixShows(1);
  const londonShows = await fetchAllTodayTixShows(2);

  // Build lookup: todaytixId → lowPriceForRegularTickets.value
  const priceMap = new Map();
  for (const tt of [...nycShows, ...londonShows]) {
    const price = tt.lowPriceForRegularTickets?.value;
    if (price != null && price > 0) {
      priceMap.set(tt.id, Math.round(price));
    }
  }
  console.log(`\nPrice data available for ${priceMap.size} TodayTix shows\n`);

  let updated = 0;
  let skipped = 0;
  let noPrice = 0;
  let noTtId = 0;

  for (const show of shows) {
    if (!show.ticketLinks) continue;
    const ttLink = show.ticketLinks.find(l => l.platform === 'TodayTix');
    if (!ttLink) continue;

    if (!show.todaytixId) {
      noTtId++;
      continue;
    }

    const price = priceMap.get(show.todaytixId);
    if (price == null) {
      noPrice++;
      continue;
    }

    // Only update if price changed or was null
    if (ttLink.priceFrom === price) {
      skipped++;
      continue;
    }

    const oldPrice = ttLink.priceFrom;
    if (!DRY_RUN) {
      ttLink.priceFrom = price;
    }
    updated++;
    console.log(`  ${show.id}: ${oldPrice ?? 'null'} → $${price}`);
  }

  console.log(`\n=== Summary ===`);
  console.log(`Updated: ${updated}`);
  console.log(`Unchanged: ${skipped}`);
  console.log(`No price in API: ${noPrice}`);
  console.log(`No todaytixId: ${noTtId}`);

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
