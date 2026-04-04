#!/usr/bin/env node
/**
 * Fetch TodayTix showtime IDs for all open shows.
 *
 * Outputs data/todaytix-showtimes.json with performance-level IDs
 * enabling deep links to TodayTix's seat selection page.
 *
 * Usage: node scripts/fetch-todaytix-showtimes.js [--dry-run] [--limit N]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'todaytix-showtimes.json');
const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT = (() => {
  const idx = process.argv.indexOf('--limit');
  return idx !== -1 ? parseInt(process.argv[idx + 1], 10) : Infinity;
})();

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

async function fetchShowtimes(todaytixId) {
  const url = `https://api.todaytix.com/api/v2/shows/${todaytixId}/showtimes`;
  try {
    const resp = await fetchJson(url);
    return resp.data || [];
  } catch (err) {
    console.warn(`  Warning: Failed to fetch showtimes for TodayTix ID ${todaytixId}: ${err.message}`);
    return [];
  }
}

/**
 * Classify a showtime as matinee (m) or evening (e).
 * Primary: use TodayTix daypart field.
 * Fallback: time < 17:00 = matinee.
 */
function classifySlot(showtime) {
  if (showtime.daypart === 'MATINEE') return 'm';
  if (showtime.daypart === 'EVENING') return 'e';
  // Fallback: time-based
  const hour = parseInt((showtime.localTime || '19:00').split(':')[0], 10);
  return hour < 17 ? 'm' : 'e';
}

async function main() {
  const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const openShows = showsData.shows.filter(s =>
    (s.status === 'open' || s.status === 'previews') && s.todaytixId
  );

  console.log(`Found ${openShows.length} open shows with todaytixId`);
  if (LIMIT < Infinity) console.log(`Limiting to ${LIMIT} shows`);

  const result = { lastUpdated: new Date().toISOString(), shows: {} };
  const toProcess = openShows.slice(0, LIMIT);
  let fetched = 0;

  for (const show of toProcess) {
    const showtimes = await fetchShowtimes(show.todaytixId);
    if (showtimes.length === 0) {
      console.log(`  ${show.title}: no showtimes`);
      continue;
    }

    const entry = { todaytixId: show.todaytixId, showtimes: {} };

    for (const st of showtimes) {
      const date = st.localDate; // YYYY-MM-DD
      if (!date) continue;
      const slot = classifySlot(st);
      if (!entry.showtimes[date]) entry.showtimes[date] = {};
      // Take the first showtime per slot (avoid duplicates)
      if (!entry.showtimes[date][slot]) {
        entry.showtimes[date][slot] = st.id;
      }
    }

    const dateCount = Object.keys(entry.showtimes).length;
    result.shows[show.id] = entry;
    fetched++;
    console.log(`  ${show.title}: ${showtimes.length} showtimes across ${dateCount} dates`);

    // Rate limit: 500ms between shows
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\nFetched showtimes for ${fetched}/${toProcess.length} shows`);

  if (DRY_RUN) {
    console.log('\n[DRY RUN] Would write to', OUTPUT_PATH);
    console.log('Sample:', JSON.stringify(Object.entries(result.shows).slice(0, 2), null, 2));
  } else {
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2) + '\n');
    console.log(`Wrote ${OUTPUT_PATH} (${(fs.statSync(OUTPUT_PATH).size / 1024).toFixed(1)}KB)`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
