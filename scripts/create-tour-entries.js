#!/usr/bin/env node
/**
 * create-tour-entries.js (BRO-4262): turn national-tour roundup candidates into
 * tour entries, with no one in the loop, when the evidence holds.
 *
 * A candidate (data/audit/tour-roundup-candidates.json, written by
 * scrape-bww-reviews.js --landing-discover) becomes a category:'tour' entry
 * only when:
 *   - BroadwayWorld published a national-tour roundup matching exactly one
 *     Broadway show (how the candidate was recorded),
 *   - Tours To You lists the tour and Wikipedia names its launch date
 *     (tour-schedule.js decideTourDates),
 *   - no earlier tour of the title is still open (buildTourEntry).
 * Anything short of that stays a candidate, and route-tour-candidates.js asks
 * the owner about it as before.
 *
 * Before that, discover-running-tours.js records tours already on the road
 * from Tours To You's full show list (BRO-4325): a roundup only ever arrives
 * for a new tour, so tours running before launch would never be found.
 * --no-discover skips it.
 *
 * Created ids go to GITHUB_OUTPUT (created=a,b) so the workflow can gather
 * reviews and sweep the Broadway parent for them.
 *
 * Usage:
 *   node scripts/create-tour-entries.js           report only (default)
 *   node scripts/create-tour-entries.js --write   write shows.json + candidates file
 * TOUR_AUTOCREATE=off|report|write (repo variable) wins; unset = report-only
 * until tour-automation-mode.js LIVE_FROM, then write.
 */

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { tourAutomationMode } = require('./lib/tour-automation-mode');
const { parseTimeBudgetMin, createRunBudget } = require('./lib/run-budget');
const { openTourCandidates, recordTourCandidates } = require('./lib/tour-roundup-candidate');
const { decideTourDates } = require('./lib/tour-schedule');
const { buildTourEntry } = require('./lib/tour-entry');
const { createShowsWriteGuard } = require('./lib/shows-write-guard');

const ROOT = path.join(__dirname, '..');
const SHOWS_PATH = path.join(ROOT, 'data', 'shows.json');
const CANDIDATES = path.join(ROOT, 'data', 'audit', 'tour-roundup-candidates.json');
const AUDIT_PATH = path.join(ROOT, 'data', 'audit', 'tour-autocreate.json');

const USAGE = `create-tour-entries.js — create national-tour entries from roundup candidates (BRO-4262)
  --write   write shows.json and mark candidates created (default: report only)
  --time-budget-min=N  stop cleanly after N minutes
  --no-discover  skip finding running tours on Tours To You
  TOUR_AUTOCREATE=off|report   kill switch / force report-only`;

async function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }
  const mode = tourAutomationMode(process.env.TOUR_AUTOCREATE);
  // Every run leaves a report, even an empty one: the daily digest reads its
  // timestamp to tell a quiet week from a job that stopped running.
  // What running-tour discovery did this run, for the health check (BRO-4325).
  let discovery = null;
  const writeAudit = (body) => {
    fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true });
    fs.writeFileSync(AUDIT_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), discovery, ...body }, null, 2) + '\n');
  };
  if (mode === 'off') { console.log('TOUR_AUTOCREATE=off — skipping'); writeAudit({ mode: 'off', created: [], results: [] }); return; }
  const write = argv.includes('--write') && mode === 'write';
  // Stop cleanly before the workflow's timeout; unprocessed candidates stay open.
  const budget = createRunBudget(parseTimeBudgetMin(argv));

  if (!argv.includes('--no-discover')) {
    try {
      const { discoverRunningTours } = require('./discover-running-tours');
      const current = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8')).shows;
      const { candidates, ambiguous, pages, checked } = await discoverRunningTours({ shows: current, budget });
      discovery = { pages, checked, found: candidates.length, ambiguous: ambiguous.length, error: null };
      // Recorded in report mode too: route-tour-candidates.js reads the file.
      const n = recordTourCandidates(CANDIDATES, candidates);
      console.log(`${candidates.length} running tour(s) found; ${n} candidate row(s) tracked`);
    } catch (e) {
      // Discovery failing must not stop roundup candidates from being created.
      console.log(`::warning::running-tour discovery failed: ${e.message}`);
      discovery = { error: e.message };
    }
  }
  if (!fs.existsSync(CANDIDATES)) { console.log('No tour candidates recorded.'); writeAudit({ mode: write ? 'write' : 'report', created: [], results: [] }); return; }

  const { fetchSchedule, fetchWikiText } = require('./enrich-tour-dates');
  const { fetchPage } = require('./lib/scraper');
  const rows = JSON.parse(fs.readFileSync(CANDIDATES, 'utf8'));
  const shows = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8')).shows;
  const byId = new Map(shows.map(s => [s.id, s]));
  const open = openTourCandidates(rows, shows);
  // A retired id must never come back (data/retired-show-ids.json, core-data).
  const retiredIds = { has: (id) => { try { return require('./lib/retired-show-ids').isRetiredId(id); } catch { return false; } } };
  console.log(`${open.length} open tour candidate(s)${write ? '' : ' (report only)'}`);

  const results = [];
  for (const c of open) {
    if (budget.exceeded()) { console.log(`Time budget reached; ${open.length - results.length} candidate(s) left for the next run`); break; }
    const parent = byId.get(c.broadwayShowId);
    console.log(`\n${c.title} (${c.broadwayShowId})`);
    // Two companies of one show on the road: which is "the" tour is the
    // owner's call (route-tour-candidates.js asks).
    if (c.ambiguous) {
      console.log(`  stays a suggestion: two tours running at once (${c.ambiguous})`);
      results.push({ candidate: c.broadwayShowId, roundupUrl: null, scheduleUrl: c.url, notes: [], skip: `two tours running at once: ${c.ambiguous}`, entry: null });
      continue;
    }
    const probe = { id: null, title: parent.title, tourScheduleSlug: c.tourScheduleSlug, openingDate: null, closingDate: null };
    // A tour found on Tours To You is fetched there plainly (no paid scraper).
    const found = c.source === 'tourstoyou';
    const { url: scheduleUrl, html } = await fetchSchedule(probe, found ? async () => '' : fetchPage);
    let wiki = '';
    try { wiki = await fetchWikiText(parent.title); } catch (e) { console.log(`  wikipedia failed: ${e.message}`); }
    const decision = scheduleUrl
      ? decideTourDates(probe, html, wiki, new Date(), found ? { segmentStart: c.segmentStart } : { seenAt: c.firstSeen || c.lastSeen })
      : { write: {}, notes: [], problem: 'no Tours To You page found for this title' };
    const roundupUrl = found ? null : c.url;
    const built = buildTourEntry({ parent, shows, decision, roundupUrl, scheduleUrl, retiredIds });
    if (built.skip) console.log(`  stays a suggestion: ${built.skip}`);
    else console.log(`  ${write ? 'creating' : 'would create'} ${built.entry.id} (${built.entry.openingDate}..${built.entry.closingDate || 'running'})`);
    results.push({ candidate: c.broadwayShowId, roundupUrl, scheduleUrl, notes: decision.notes, skip: built.skip || null, entry: built.entry || null });
  }

  const created = [];
  if (write && results.some(r => r.entry)) {
    const { loadShows, saveShows } = createShowsWriteGuard(SHOWS_PATH);
    const snapshot = loadShows();
    for (const r of results.filter(x => x.entry)) {
      // Re-check under the write lock: another run may have added it, or a
      // tour of the title may have been added or reopened meanwhile.
      if (snapshot.shows.some(s => s.id === r.entry.id)) continue;
      const recheck = buildTourEntry({ parent: snapshot.shows.find(s => s.id === r.candidate), shows: snapshot.shows, decision: { write: { openingDate: r.entry.openingDate, closingDate: r.entry.closingDate }, notes: r.notes }, roundupUrl: r.roundupUrl, scheduleUrl: r.scheduleUrl, retiredIds });
      if (recheck.skip) { console.log(`  ${r.entry.id} skipped under lock: ${recheck.skip}`); continue; }
      snapshot.shows.push(r.entry);
      created.push(r.entry.id);
    }
    if (created.length) {
      saveShows(snapshot);
      const now = new Date().toISOString();
      const next = rows.map(row => {
        const hit = results.find(x => x.candidate === row.broadwayShowId && x.entry && created.includes(x.entry.id));
        return hit ? { ...row, createdTourId: hit.entry.id, createdAt: now } : row;
      });
      fs.writeFileSync(CANDIDATES, JSON.stringify(next, null, 2) + '\n');
    }
  }

  writeAudit({ mode: write ? 'write' : 'report', created, results });
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `created=${created.join(',')}\n`);
  console.log(`\n${write ? `Created ${created.length}` : `${results.filter(r => r.entry).length} would be created`}; ${results.filter(r => r.skip).length} stay suggestions.`);
}

if (require.main === module) {
  main()
    .catch((e) => { console.error(e); process.exitCode = 1; })
    .finally(() => require('./lib/scraper').cleanup().catch(() => {}).finally(() => process.exit(process.exitCode || 0)));
}
