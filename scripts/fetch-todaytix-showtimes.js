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

    // Group showtimes by date first, then classify
    const byDate = {};
    for (const st of showtimes) {
      const date = st.localDate;
      if (!date) continue;
      if (!byDate[date]) byDate[date] = [];
      byDate[date].push(st);
    }

    for (const [date, dayShowtimes] of Object.entries(byDate)) {
      entry.showtimes[date] = {};
      showSchedule[date] = {};

      if (dayShowtimes.length === 1) {
        // Single show: use daypart or time-based classification
        const st = dayShowtimes[0];
        const slot = classifySlot(st);
        entry.showtimes[date][slot] = st.id;
        showSchedule[date][slot] = st.localTime || null;
      } else {
        // Multiple shows: earliest = matinee, latest = evening
        dayShowtimes.sort((a, b) => (a.localTime || '').localeCompare(b.localTime || ''));
        const earliest = dayShowtimes[0];
        const latest = dayShowtimes[dayShowtimes.length - 1];
        entry.showtimes[date].m = earliest.id;
        showSchedule[date].m = earliest.localTime || null;
        if (latest !== earliest) {
          entry.showtimes[date].e = latest.id;
          showSchedule[date].e = latest.localTime || null;
        }
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

  // Safety guard: abort if we fetched dramatically fewer shows than expected
  // (prevents silent data loss from API outage)
  if (LIMIT === Infinity && fetched < toProcess.length * 0.5) {
    console.error(`ERROR: Only fetched ${fetched}/${toProcess.length} shows (< 50%). TodayTix API may be down. Aborting to preserve existing data.`);
    process.exit(1);
  }

  if (DRY_RUN) {
    console.log('\n[DRY RUN] Would write to', OUTPUT_PATH);
    console.log('Sample:', JSON.stringify(Object.entries(result.shows).slice(0, 2), null, 2));
  } else {
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2) + '\n');
    console.log(`Wrote ${OUTPUT_PATH} (${(fs.statSync(OUTPUT_PATH).size / 1024).toFixed(1)}KB)`);
  }

  // Generate schedule entries for shows not already covered by bwayrush
  // Also clean up closed shows from TodayTix-sourced schedules
  const openShowIds = new Set(openShows.map(s => s.id));
  generateSchedules(scheduleData, openShowIds);
}

/**
 * Build show-schedules.json entries from TodayTix data.
 * Only adds shows NOT already in the file (bwayrush data takes priority).
 * Also removes TodayTix-sourced shows that are no longer open.
 */
function generateSchedules(scheduleData, openShowIds) {
  const schedules = JSON.parse(fs.readFileSync(SCHEDULES_PATH, 'utf8'));

  // Clean up closed shows from TodayTix-sourced schedules
  // (bwayrush shows are managed by the bwayrush scraper, don't touch them)
  const bwayrushShows = new Set(Object.keys(scheduleData).length === 0 ? [] :
    Object.keys(schedules.shows).filter(id => !scheduleData[id] && schedules.shows[id]));
  let removed = 0;
  for (const showId of Object.keys(schedules.shows)) {
    // Skip bwayrush-sourced shows (they were in schedules before TodayTix)
    if (!showId.includes('west-end') && !showId.includes('off-broadway') && !showId.includes('off-west-end')) continue;
    if (!openShowIds.has(showId)) {
      delete schedules.shows[showId];
      removed++;
    }
  }
  if (removed > 0) console.log(`Schedules: removed ${removed} closed WE/OB shows`);

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

  // Update currentMonday to keep staleness check accurate
  const now = new Date();
  const dow = now.getDay();
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  const monday = new Date(now);
  monday.setDate(now.getDate() + mondayOffset);
  const currentMonday = monday.getFullYear().toString() +
    String(monday.getMonth() + 1).padStart(2, '0') +
    String(monday.getDate()).padStart(2, '0');
  schedules.currentMonday = currentMonday;

  schedules.lastUpdated = new Date().toISOString();
  if (!DRY_RUN) {
    fs.writeFileSync(SCHEDULES_PATH, JSON.stringify(schedules, null, 2) + '\n');
  }
  if (added > 0) {
    console.log(`Schedules: added ${added} shows (${existingCount} bwayrush + ${added} TodayTix = ${existingCount + added} total)`);
  } else {
    console.log(`Schedules: currentMonday updated to ${currentMonday}, no new shows`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
