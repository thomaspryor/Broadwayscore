#!/usr/bin/env node
/**
 * Audit (and optionally fix) show runtimes against the TodayTix show PAGE.
 *
 * Why: the TodayTix REST API's runningTime can be stale (Birthright: API said
 * 90 min, page said 3hr 30min) — see scripts/lib/todaytix-runtime.js header.
 * Broadway shows self-heal weekly via scrape-broadway-com-runtimes.js, but
 * off-Broadway / West End shows had no correction source until this script.
 *
 * Usage:
 *   node scripts/audit-todaytix-runtimes.js [--fix] [--all] [--show=ID] [--limit=N]
 *
 * Default scope: open/previews/upcoming shows with a todaytixUrl.
 * --all audits every show with a todaytixUrl (closed pages may 404 — those are skipped).
 * Exits 1 if mismatches were found and --fix was not passed.
 *
 * Drift guard: if >30% of checked shows mismatch (min 30 checked), --fix
 * refuses to write and exits 2 — a rate that high means the parser or the
 * source drifted, not the data. Override with --force for known backfills.
 */

const fs = require('fs');
const path = require('path');
const { fetchPage, cleanup } = require('./lib/scraper');
const { atomicWriteShowsJson } = require('./lib/atomic-shows-write');
const {
  extractRunTimeDisplay,
  parseRunTimeDisplay,
  parseCompactRuntime,
  todaytixPageUrl,
} = require('./lib/todaytix-runtime');

const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const FIX = process.argv.includes('--fix');
const FORCE = process.argv.includes('--force');
const ALL = process.argv.includes('--all');
const SHOW_FILTER = process.argv.find(a => a.startsWith('--show='))?.split('=')[1] || null;
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '0', 10);

const ACTIVE_STATUSES = new Set(['open', 'previews', 'upcoming']);
// Small differences aren't worth churning data over (page often rounds).
const MINUTES_TOLERANCE = 5;
// Above this mismatch rate, assume parser/source drift and refuse to auto-fix.
const DRIFT_RATE_LIMIT = 0.3;
const DRIFT_MIN_CHECKED = 30;

function saveShows(showsData) {
  atomicWriteShowsJson(SHOWS_PATH, showsData);
}

function driftTripped(mismatchCount, checked) {
  return !FORCE && checked >= DRIFT_MIN_CHECKED &&
    mismatchCount / checked > DRIFT_RATE_LIMIT;
}

async function main() {
  const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const shows = showsData.shows;

  let targets = shows.filter(s => s.todaytixUrl || s.todaytixId);
  if (SHOW_FILTER) targets = targets.filter(s => s.id === SHOW_FILTER);
  else if (!ALL) targets = targets.filter(s => ACTIVE_STATUSES.has(s.status));
  if (LIMIT > 0) targets = targets.slice(0, LIMIT);

  console.log(`Auditing ${targets.length} shows against TodayTix pages (fix=${FIX})\n`);

  const mismatches = [];
  let checked = 0, unreadable = 0, fixed = 0;

  for (const show of targets) {
    const url = todaytixPageUrl(show);
    let html = null;
    try {
      const result = await fetchPage(url, { renderJs: false, fast: true });
      html = result && result.content;
    } catch (e) {
      console.log(`  ${show.id}: fetch failed (${e.message}) — skipping`);
      unreadable++;
      continue;
    }

    const display = extractRunTimeDisplay(html);
    const parsed = parseRunTimeDisplay(display);
    if (!parsed) {
      console.log(`  ${show.id}: no parseable run time on page${display ? ` ("${display}")` : ''}`);
      unreadable++;
      continue;
    }
    checked++;

    const ourMinutes = parseCompactRuntime(show.runtime);
    const runtimeDiffers = ourMinutes == null ||
      Math.abs(ourMinutes - parsed.minutes) > MINUTES_TOLERANCE;
    // Differs when the page states a count and ours is wrong OR missing —
    // so shows with a correct runtime still get intermissions backfilled.
    const intermissionsDiffer = parsed.intermissions != null &&
      show.intermissions !== parsed.intermissions;

    if (!runtimeDiffers && !intermissionsDiffer) continue;

    mismatches.push({
      id: show.id,
      status: show.status,
      ours: { runtime: show.runtime || null, intermissions: show.intermissions ?? null },
      page: { display, runtime: parsed.runtime, intermissions: parsed.intermissions },
    });
    console.log(`  ❌ ${show.id}: ours=${show.runtime || 'none'}/${show.intermissions ?? '?'}int → page="${display}"`);

    if (FIX) {
      show.runtime = parsed.runtime;
      if (parsed.intermissions != null) show.intermissions = parsed.intermissions;
      fixed++;
      // Checkpoint incrementally so a crash mid-run doesn't lose fixes —
      // but never once the drift guard has tripped.
      if (fixed % 10 === 0 && !driftTripped(mismatches.length, checked)) {
        saveShows(showsData);
      }
    }
  }

  const drifted = driftTripped(mismatches.length, checked);
  if (FIX && fixed > 0 && !drifted) saveShows(showsData);
  await cleanup();

  console.log(`\n=== Summary ===`);
  console.log(`Checked: ${checked}, unreadable/skipped: ${unreadable}`);
  console.log(`Mismatches: ${mismatches.length}${FIX ? `, fixed: ${fixed}` : ''}`);
  for (const m of mismatches) {
    console.log(`  ${m.id} [${m.status}]: ${m.ours.runtime}/${m.ours.intermissions}int → ${m.page.runtime}/${m.page.intermissions ?? '?'}int`);
  }

  if (drifted && FIX) {
    console.error(`\n🛑 DRIFT GUARD: ${mismatches.length}/${checked} mismatch rate exceeds ${DRIFT_RATE_LIMIT * 100}% — ` +
      `parser or source likely drifted. NOT writing. Re-run with --force if this is an intentional backfill.`);
    process.exit(2);
  }
  if (mismatches.length > 0 && !FIX) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
