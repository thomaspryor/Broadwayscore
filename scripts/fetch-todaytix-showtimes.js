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

const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'todaytix-showtimes.json');
const SCHEDULES_PATH = path.join(__dirname, '..', 'data', 'show-schedules.json');
const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT = (() => {
  const idx = process.argv.indexOf('--limit');
  return idx !== -1 ? parseInt(process.argv[idx + 1], 10) : Infinity;
})();

async function fetchJson(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${url}`);
  return resp.json();
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
  // Also collect time data for schedule generation (date → { m: "HH:mm", e: "HH:mm" })
  const scheduleData = {};
  const toProcess = openShows.slice(0, LIMIT);
  let fetched = 0;

  for (const show of toProcess) {
    const showtimes = await fetchShowtimes(show.todaytixId);
    if (showtimes.length === 0) {
      console.log(`  ${show.title}: no showtimes`);
      continue;
    }

    const entry = { todaytixId: show.todaytixId, showtimes: {} };
    const showSchedule = {}; // date → { m: time, e: time }

    for (const st of showtimes) {
      const date = st.localDate; // YYYY-MM-DD
      if (!date) continue;
      const slot = classifySlot(st);
      if (!entry.showtimes[date]) entry.showtimes[date] = {};
      if (!showSchedule[date]) showSchedule[date] = {};
      // Take the first showtime per slot (avoid duplicates)
      if (!entry.showtimes[date][slot]) {
        entry.showtimes[date][slot] = st.id;
        showSchedule[date][slot] = st.localTime || null;
      }
    }

    const dateCount = Object.keys(entry.showtimes).length;
    result.shows[show.id] = entry;
    scheduleData[show.id] = showSchedule;
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

  // Generate schedule entries for shows not already covered by bwayrush
  generateSchedules(scheduleData);
}

/**
 * Build show-schedules.json entries from TodayTix data.
 * Only adds shows NOT already in the file (bwayrush data takes priority).
 */
function generateSchedules(scheduleData) {
  const schedules = JSON.parse(fs.readFileSync(SCHEDULES_PATH, 'utf8'));
  const existingCount = Object.keys(schedules.shows).length;
  let added = 0;

  for (const [showId, dateMap] of Object.entries(scheduleData)) {
    if (schedules.shows[showId]) continue; // bwayrush already has it

    const dates = Object.keys(dateMap).sort();
    if (dates.length === 0) continue;

    // Group dates into Mon-Sun weeks
    const weeks = {};
    for (const dateStr of dates) {
      const d = new Date(dateStr + 'T12:00:00');
      const dow = d.getDay(); // 0=Sun
      const mondayOffset = dow === 0 ? -6 : 1 - dow;
      const monday = new Date(d);
      monday.setDate(d.getDate() + mondayOffset);
      const key = monday.getFullYear().toString() +
        String(monday.getMonth() + 1).padStart(2, '0') +
        String(monday.getDate()).padStart(2, '0');

      if (!weeks[key]) {
        weeks[key] = Array.from({ length: 7 }, () => ({ m: null, e: null }));
      }

      const dayIdx = dow === 0 ? 6 : dow - 1;
      const slots = dateMap[dateStr];
      if (slots.m) weeks[key][dayIdx].m = slots.m;
      if (slots.e) weeks[key][dayIdx].e = slots.e;
    }

    schedules.shows[showId] = { weeks };
    added++;
  }

  if (added > 0) {
    schedules.lastUpdated = new Date().toISOString();
    if (!DRY_RUN) {
      fs.writeFileSync(SCHEDULES_PATH, JSON.stringify(schedules, null, 2) + '\n');
    }
    console.log(`Schedules: added ${added} shows (${existingCount} bwayrush + ${added} TodayTix = ${existingCount + added} total)`);
  } else {
    console.log('Schedules: no new shows to add');
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
