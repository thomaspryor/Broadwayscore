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
const { segmentTourRows, pickSegment, currentSegment, parseTourSchedule, duplicateScheduleOf, singleCompanyPath } = require('./lib/tour-schedule');
const { fetchSchedule } = require('./lib/tours-to-you');
const { createRunBudget } = require('./lib/run-budget');

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
const MAX_LAYOFF_DAYS = 365;

function tourStops(tour, html, now = new Date()) {
  const segments = segmentTourRows(parseTourSchedule(html));
  // The segment holding the launch; else the one running now, when it began
  // after the launch (Wicked's page starts in Oct 2021, after its Aug 2021
  // restart, BRO-4601).
  // Within 120 days of the launch only (Wicked: 85), so an old tour still
  // marked open never takes a new company's schedule (code review).
  const running = currentSegment(segments, now);
  const launchMs = tour.openingDate ? Date.parse(`${String(tour.openingDate).slice(0, 10)}T00:00:00Z`) : NaN;
  const lag = running ? running.start.getTime() - launchMs : NaN;
  const segment = pickSegment(segments, tour, '')
    || (running && lag >= 0 && lag <= 120 * 86400000 ? running : null);
  if (!segment) return null;
  // Only the current era: a long-running title's page can run several
  // companies together back to 2020 (Hamilton); stops before this tour's
  // launch belong to an earlier company (BRO-4601).
  const from = tour.openingDate ? Date.parse(`${String(tour.openingDate).slice(0, 10)}T00:00:00Z`) - 7 * 86400000 : -Infinity;
  // ...and none after it closed: A Beautiful Noise's page runs a second
  // company on from Oct 2026 after the first closed in July.
  const until = tour.closingDate ? Date.parse(`${String(tour.closingDate).slice(0, 10)}T00:00:00Z`) : Infinity;
  // A still-open tour whose leg has ended carries on into the page's next leg
  // (Kinky Boots: Jul 2026, then Mar 2027). A closed tour's later leg is a new
  // company, which the closingDate cut below already keeps out. A layoff
  // longer than a year reads as a new company, never this tour's next leg.
  let pool = segment.rows;
  const legOver = segment.rows[segment.rows.length - 1].end < now;
  if (!tour.closingDate && legOver) pool = segments.slice(segments.indexOf(segment)).flatMap(s => s.rows);
  const inRange = pool.filter(r => r.start.getTime() >= from && r.start.getTime() <= until);
  // One company can't play two cities at once. Pages that run several
  // companies in one "Past Seasons" table (Hamilton, Lion King, Six) or list
  // a stop twice in error (Outsiders: DC and Chicago both Aug 2026) leave
  // overlapping rows; keep the single path from the launch stop (BRO-4723).
  const { kept: rows, dropped } = singleCompanyPath(inRange, pool === segment.rows ? undefined : MAX_LAYOFF_DAYS);
  for (const r of dropped) console.log(`::warning::${tour.id}: dropped overlapping stop ${r.city} ${iso(r.start)}..${iso(r.end)}`);
  return rows.length ? rows.map(r => ({ city: r.city, venue: r.venue, start: iso(r.start), end: iso(r.end) })) : null;
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log('fetch-tour-schedules.js [--show=ID]'); return; }
  const only = (argv.find(a => a.startsWith('--show=')) || '').split('=')[1] || null;

  const shows = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8')).shows;
  const out = fs.existsSync(OUT_PATH) ? JSON.parse(fs.readFileSync(OUT_PATH, 'utf8')) : { tours: {} };
  // A closed tour is fetched until it has a schedule (BRO-4656): the review
  // sweep and stop-review discovery date reviews against its stops, and half
  // the tours (every closed one) had none.
  const targets = shows.filter(s => s.category === 'tour'
    && (only ? s.id === only : (s.status !== 'closed' || !(out.tours[s.id] && out.tours[s.id].stops && out.tours[s.id].stops.length))));

  let failed = 0;
  let changed = 0;
  // The job's timeout is 30 min; 429 backoffs (tours-to-you.js) stop waiting
  // as this runs low, and tours not reached keep their saved stops.
  const budget = createRunBudget(22);
  for (const [i, tour] of targets.entries()) {
    if (budget.exceeded()) { console.log(`Time budget reached; ${targets.length - i} tour(s) keep their saved stops until tomorrow`); break; }
    if (i > 0) await sleep(PAUSE_MS);
    const { url, html } = await fetchSchedule(tour, null, { budget });
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
