#!/usr/bin/env node
/**
 * fetch-tour-schedules.js (BRO-4601): every listed national tour's engagement
 * list (city, venue, dates), for the "Now in / Next" lines and the tour
 * schedule on show pages.
 *
 * Same source and parsing as enrich-tour-dates.js: Tours To You via
 * fetchSchedule, split into tours by segmentTourRows, and the segment that
 * matches the tour's launch date picked by pickSegment. A tour whose page
 * parses to nothing keeps its previous stops: silence never clears a schedule.
 *
 * Writes data/tour-schedules.json:
 *   { tours: { <id>: { source, updatedAt, stops: [{ city, venue, start, end }] } } }
 *
 * Usage:
 *   node scripts/fetch-tour-schedules.js            all running/upcoming tours
 *   node scripts/fetch-tour-schedules.js --show=ID  one tour
 *
 * Run daily by .github/workflows/fetch-tour-schedules.yml. The file is written
 * only when some tour's stops changed (updatedAt marks that tour's change), so
 * an unchanged day commits nothing. Exits 1 when more than half the tours
 * could not be read, so a dead source shows up as a failed run.
 */

// venue-write-guard-ok: writes data/tour-schedules.json stop objects (city/venue/dates of a tour engagement), never a shows.json venue.
const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { segmentTourRows, pickSegment, parseTourSchedule, duplicateScheduleOf } = require('./lib/tour-schedule');
const { fetchSchedule } = require('./lib/tours-to-you');

const ROOT = path.join(__dirname, '..');
const SHOWS_PATH = path.join(ROOT, 'data', 'shows.json');
const OUT_PATH = path.join(ROOT, 'data', 'tour-schedules.json');

const iso = d => d.toISOString().slice(0, 10);
// Tours To You answered 429 to 3 of 13 back-to-back requests (BRO-4601).
const PAUSE_MS = 6000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** The tour's stored launch is within 14 days of these stops' first engagement. */
function opensWith(tour, stops) {
  if (!tour || !tour.openingDate || !stops.length) return false;
  return Math.abs(Date.parse(stops[0].start) - Date.parse(String(tour.openingDate).slice(0, 10))) <= 14 * 86400000;
}

/** The stops of the segment that is this tour, or null. Pure. */
function tourStops(tour, html) {
  const segment = pickSegment(segmentTourRows(parseTourSchedule(html)), tour, '');
  if (!segment) return null;
  return segment.rows.map(r => ({ city: r.city, venue: r.venue, start: iso(r.start), end: iso(r.end) }));
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log('fetch-tour-schedules.js [--show=ID]'); return; }
  const only = (argv.find(a => a.startsWith('--show=')) || '').split('=')[1] || null;

  const shows = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8')).shows;
  const targets = shows.filter(s => s.category === 'tour' && (only ? s.id === only : s.status !== 'closed'));
  const out = fs.existsSync(OUT_PATH) ? JSON.parse(fs.readFileSync(OUT_PATH, 'utf8')) : { tours: {} };

  let failed = 0;
  let changed = 0;
  for (const [i, tour] of targets.entries()) {
    if (i > 0) await sleep(PAUSE_MS);
    const { url, html } = await fetchSchedule(tour);
    const stops = url ? tourStops(tour, html) : null;
    if (!stops) { failed++; console.log(`${tour.id}: no schedule (kept ${out.tours[tour.id] ? 'previous' : 'none'})`); continue; }
    // Another show's table on this page (BRO-4601: Come From Away's page showed
    // Operation Mincemeat's tour) must not become this tour's schedule.
    const copyOf = duplicateScheduleOf(stops, out.tours, { exceptId: tour.id });
    if (copyOf) {
      // The table belongs to the tour that opened with its first stop. If that
      // is this tour, the other's saved schedule was the copy: drop it so the
      // first-saved page can't lock the real tour out.
      const other = shows.find(s => s.id === copyOf);
      if (opensWith(tour, stops) && !opensWith(other, stops)) {
        console.log(`::warning::${copyOf}: its saved schedule is ${tour.id}'s table; dropped`);
        delete out.tours[copyOf];
        changed++;
      } else {
        failed++;
        console.log(`::warning::${tour.id}: schedule duplicates ${copyOf}'s engagements; kept previous`);
        continue;
      }
    }
    const prev = out.tours[tour.id];
    if (prev && prev.source === url && JSON.stringify(prev.stops) === JSON.stringify(stops)) { console.log(`${tour.id}: unchanged`); continue; }
    out.tours[tour.id] = { source: url, updatedAt: new Date().toISOString(), stops };
    changed++;
    console.log(`${tour.id}: ${stops.length} stops, ${stops[0].city} ${stops[0].start} .. ${stops[stops.length - 1].city} ${stops[stops.length - 1].end}`);
  }
  if (changed) fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n');
  console.log(`${changed} changed, ${failed} failed of ${targets.length}`);
  if (targets.length && failed / targets.length > 0.5) {
    console.error(`::error::${failed}/${targets.length} tour schedules could not be read from Tours To You`);
    process.exit(1);
  }
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });

module.exports = { tourStops, opensWith };
