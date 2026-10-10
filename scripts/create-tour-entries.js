#!/usr/bin/env node
/**
 * create-tour-entries.js (BRO-4262): turn national-tour roundup candidates into
 * tour entries, with no one in the loop, when the evidence holds.
 *
 * A candidate (data/audit/tour-roundup-candidates.json, written by
 * scrape-bww-reviews.js --landing-discover and discover-running-tours.js)
 * becomes a category:'tour' entry only when:
 *   - it is a production (tour-page-class.js): a BroadwayWorld national-tour
 *     roundup matched a Broadway, Off-Broadway or regional show, or a Tours To
 *     You page is a tracked production in any market, or a standalone touring
 *     show (no tracked parent, BRO-4931; TOUR_STANDALONE_AUTOCREATE),
 *   - Tours To You lists the tour and its launch is confirmed (tour-schedule.js
 *     decideTourDates: Wikipedia, a BWW roundup, or a launch now or booked ahead),
 *   - no earlier tour of the title is still open (buildTourEntry).
 * Anything short of that stays a candidate, and route-tour-candidates.js asks
 * the owner about it as before. The evidence rules live in
 * lib/tour-create-decision.js, shared with check-tour-sweep.js.
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
 * TOUR_STANDALONE_AUTOCREATE=off|report|write governs tours with no tracked
 * production behind them (BRO-4931); default report, never louder than
 * TOUR_AUTOCREATE. NOTE: the daily step in .github/workflows/scrape-new-aggregators.yml
 * passes only TOUR_AUTOCREATE, so the variable has no effect in CI until that
 * step's env also carries TOUR_STANDALONE_AUTOCREATE: ${{ vars.TOUR_STANDALONE_AUTOCREATE }}
 * (a workflow edit that needs the infrastructure review first). Until then the
 * daily job reports standalone tours and a person writes the first batch with
 * --only. A tour of an Off-Broadway or regional parent is written only with 5+
 * distinct cities and a launch confirmed by Wikipedia, a BWW roundup or by hand
 * (lib/tour-create-decision.js); a UK parent only through an override row.
 */

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { tourAutomationMode, standaloneTourMode } = require('./lib/tour-automation-mode');
// A tour booked ahead is created as 'upcoming' (tour-discovery.js).
const { reopenBlocker, candidateKey } = require('./lib/tour-discovery');
const { toursOfTitle } = require('./lib/tour-family');
const { writeClosingDate } = require('./lib/closing-date-guard');
const { parseTimeBudgetMin, createRunBudget } = require('./lib/run-budget');
const { openTourCandidates, recordTourCandidates, candidateParentId, sortForCreate } = require('./lib/tour-roundup-candidate');
const { buildTourEntry } = require('./lib/tour-entry');
const { decideTourCreation, candidateRoundupUrl } = require('./lib/tour-create-decision');
const { loadTourPageClasses } = require('./lib/tour-page-class');
const { createShowsWriteGuard } = require('./lib/shows-write-guard');

const ROOT = path.join(__dirname, '..');
const SHOWS_PATH = path.join(ROOT, 'data', 'shows.json');
const CANDIDATES = path.join(ROOT, 'data', 'audit', 'tour-roundup-candidates.json');
const AUDIT_PATH = path.join(ROOT, 'data', 'audit', 'tour-autocreate.json');

const USAGE = `create-tour-entries.js — create national-tour entries from roundup candidates (BRO-4262)
  --write   write shows.json and mark candidates created (default: report only)
  --time-budget-min=N  stop cleanly after N minutes
  --no-discover  skip finding running tours on Tours To You
  --only=ID,ID   only these candidates (parent ids or page keys such as page:the-bodyguard), e.g. a first small batch
  TOUR_AUTOCREATE=off|report   kill switch / force report-only
  TOUR_STANDALONE_AUTOCREATE=off|report|write   tours with no tracked production (default report, never louder than TOUR_AUTOCREATE)`;

async function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }
  const mode = tourAutomationMode(process.env.TOUR_AUTOCREATE);
  // Tours with no tracked production behind them are new ground: own switch, default report (BRO-4931).
  const standaloneMode = standaloneTourMode(process.env.TOUR_STANDALONE_AUTOCREATE, mode);
  // Every run leaves a report, even an empty one: the daily digest reads its
  // timestamp to tell a quiet week from a job that stopped running.
  // What running-tour discovery did this run, for the health check (BRO-4325).
  let discovery = null;
  // Closed tours the schedule pages list again (BRO-4724).
  let lifecycle = { reopen: [], undecided: [] };
  // Which Tours To You pages discovery read when (BRO-4725): kept across runs
  // in this file, carried over unchanged by a run that skips or fails discovery.
  let prevCoverage = {};
  try { prevCoverage = (JSON.parse(fs.readFileSync(AUDIT_PATH, 'utf8')).discovery || {}).coverage || {}; } catch { /* first run */ }
  const writeAudit = (body) => {
    fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true });
    const d = { ...(discovery || {}) };
    if (!d.coverage) d.coverage = prevCoverage;
    fs.writeFileSync(AUDIT_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), discovery: d, lifecycle, ...body }, null, 2) + '\n');
  };
  if (mode === 'off') { console.log('TOUR_AUTOCREATE=off — skipping'); writeAudit({ mode: 'off', created: [], results: [] }); return; }
  const write = argv.includes('--write') && mode === 'write';
  // Stop cleanly before the workflow's timeout; unprocessed candidates stay open.
  const budgetMin = parseTimeBudgetMin(argv);
  const budget = createRunBudget(budgetMin);
  // Discovery gets three quarters, so open candidates still get their turn;
  // pages it doesn't reach are read first next run (BRO-4725).
  const discoveryBudget = createRunBudget(budgetMin * 0.75);
  // The paid chain only when Tours To You rate-limits the plain GET (tours-to-you.js).
  const fallback = url => require('./lib/scraper').fetchPage(url);

  if (!argv.includes('--no-discover')) {
    try {
      const { discoverRunningTours } = require('./discover-running-tours');
      const current = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8')).shows;
      const r = await discoverRunningTours({ shows: current, budget: discoveryBudget, coverage: prevCoverage, fallback, overrides: loadTourPageClasses() });
      const { candidates, ambiguous, pages, checked } = r;
      lifecycle = { reopen: r.reopen || [], undecided: r.undecided || [] };
      for (const u of lifecycle.undecided) console.log(`  ${u.id} closed ${u.closingDate} but its page lists it from ${u.resumes}; left as is: ${u.reason}`);
      discovery = { pages, eligible: r.eligible, checked, failed: r.failed, rateLimited: r.rateLimited, found: candidates.length, ambiguous: ambiguous.length, error: null, coverage: r.coverage, classes: r.classes, denied: r.denied, autoClassified: r.autoClassified };
      // Recorded in report mode too: route-tour-candidates.js reads the file.
      const n = recordTourCandidates(CANDIDATES, candidates);
      console.log(`${candidates.length} running tour(s) found; ${n} candidate row(s) tracked`);
      // Save what discovery read now: a step killed later in the run must not
      // send the next run back to the same pages (BRO-4725 review).
      writeAudit({ mode: write ? 'write' : 'report', created: [], results: [], partial: true });
    } catch (e) {
      // Discovery failing must not stop roundup candidates from being created.
      console.log(`::warning::running-tour discovery failed: ${e.message}`);
      discovery = { error: e.message };
    }
  }
  if (!fs.existsSync(CANDIDATES)) { console.log('No tour candidates recorded.'); writeAudit({ mode: write ? 'write' : 'report', created: [], results: [] }); return; }

  const { fetchSchedule, fetchWikiText, fetchWikiArticle } = require('./enrich-tour-dates');
  const rows = JSON.parse(fs.readFileSync(CANDIDATES, 'utf8'));
  const shows = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8')).shows;
  const byId = new Map(shows.map(s => [s.id, s]));
  const overrides = loadTourPageClasses();
  // --only: a small first batch (BRO-4601 plan review: 2 tours end to end
  // before the rest; CLAUDE.md section 8). Takes a parent id, a page key
  // (page:<slug>) or a Tours To You slug.
  const only = ((argv.find(a => a.startsWith('--only=')) || '').split('=')[1] || '').split(',').filter(Boolean);
  const wanted = c => !only.length || [candidateKey(c), candidateParentId(c), c.tourScheduleSlug, c.tourScheduleSlug && `page:${c.tourScheduleSlug}`].some(k => k && only.includes(k));
  const open = sortForCreate(openTourCandidates(rows, shows).filter(wanted));
  if (only.length) console.log(`--only: ${only.join(', ')}`);
  // A retired id must never come back (data/retired-show-ids.json, core-data).
  const retiredIds = { has: (id) => { try { return require('./lib/retired-show-ids').isRetiredId(id); } catch { return false; } } };
  console.log(`${open.length} open tour candidate(s)${write ? '' : ' (report only)'}`);

  const tourSchedules = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'tour-schedules.json'), 'utf8')).tours || {}; } catch { return {}; }
  })();
  const results = [];
  let ledgerChanged = false;
  for (const c of open) {
    if (budget.exceeded()) { console.log(`Time budget reached; ${open.length - results.length} candidate(s) left for the next run`); break; }
    const parentId = candidateParentId(c);
    const parent = parentId ? byId.get(parentId) : null;
    const key = candidateKey(c);
    const standalone = !parent;
    console.log(`\n${c.title} (${key})`);
    const record = (extra) => results.push({ candidate: key, parentId: parentId || null, standalone, title: c.title, type: c.type || null, roundupUrl: null, scheduleUrl: c.url, notes: [], entry: null, ...extra });
    if (parentId && !parent) { console.log(`  stays a suggestion: parent ${parentId} is not in shows.json`); record({ skip: `parent ${parentId} not found` }); continue; }
    // Standalone tours are new ground: their own switch (tour-automation-mode.js).
    if (standalone && standaloneMode === 'off') { console.log('  stays a suggestion: TOUR_STANDALONE_AUTOCREATE=off'); record({ skip: 'standalone tours are off' }); continue; }
    // Two companies of one show on the road: which is "the" tour is the
    // owner's call (route-tour-candidates.js asks).
    if (c.ambiguous) {
      console.log(`  stays a suggestion: two tours running at once (${c.ambiguous})`);
      record({ skip: `two tours running at once: ${c.ambiguous}` });
      continue;
    }
    const title = parent ? parent.title : c.title;
    const probe = { id: null, title, tourScheduleSlug: c.tourScheduleSlug, openingDate: null, closingDate: null };
    // Plain GET first; the paid chain only on a 429 (BRO-4725: 429s left
    // Tours To You-found tours with "no evidence URL" on 2026-10-05).
    const { url: scheduleUrl, html } = await fetchSchedule(probe, fallback, { budget });
    let wiki = '';
    try { wiki = await fetchWikiText(title); } catch (e) { console.log(`  wikipedia failed: ${e.message}`); }
    // A page nothing classified also gets the first article that exists, for its infobox only: it can
    // be another work (Clue -> the 1997 musical), so it never feeds the date decision above.
    let classifyWiki = null;
    if (c.needsClassification && !parent) { try { classifyWiki = await fetchWikiArticle(title, { requireTour: false }); } catch (e) { console.log(`  wikipedia (classification) failed: ${e.message}`); } }
    // A schedule row may carry the BWW roundup seen for the same show
    // (recordTourCandidates), or a roundup-only row pairs with this page by
    // title; its date confirms the launch when Wikipedia is silent (BRO-4563).
    const roundupUrl = candidateRoundupUrl(c, rows);
    const d = decideTourCreation({ candidate: c, parent, shows, scheduleUrl, html, wikiText: wiki, classifyWiki, roundupUrl, retiredIds, tourSchedules, overrides });
    // What Wikipedia's infobox said about a page discovery could not classify goes back on its row, so the
    // owner digest asks about a launch that cannot be confirmed, not about what the page is.
    if (!parent && c.needsClassification) {
      if (d.candidate) { c.pageClass = 'production'; c.type = d.candidate.type; delete c.needsClassification; ledgerChanged = true; }
      else if (d.pageClass && d.pageClass.class !== 'unclassified') { c.pageClass = d.pageClass.class; delete c.needsClassification; ledgerChanged = true; }
    }
    if (d.outcome === 'needs-classification' || /^skip-(event|aggregator|template|company)$/.test(d.outcome)) {
      console.log(`  stays a suggestion: ${d.outcome === 'needs-classification' ? 'needs a human to say what this page is' : d.outcome}: ${d.reason}`);
      record({ roundupUrl, scheduleUrl, skip: d.reason, outcome: d.outcome });
      continue;
    }
    const built = d.built;
    if (built.skip) console.log(`  stays a suggestion: ${built.skip}`);
    else console.log(`  ${write && (!standalone || standaloneMode === 'write') ? 'creating' : 'would create'} ${built.entry.id} (${built.entry.openingDate}..${built.entry.closingDate || 'running'})${standalone ? ' [standalone]' : ''}`);
    record({ roundupUrl, scheduleUrl, notes: d.decision.notes, launchSource: d.decision.launchSource || null, knownEnds: d.knownEnds, skip: built.skip || null, entry: built.entry || null, outcome: d.outcome, type: d.candidate.type || null });
  }

  if (ledgerChanged) fs.writeFileSync(CANDIDATES, JSON.stringify(rows, null, 2) + '\n');
  const created = [];
  const reopened = [];
  for (const x of lifecycle.reopen) console.log(`${x.id}: ${write ? 'reopening' : 'would reopen'} (closed ${x.closingDate}, its page lists it again from ${x.resumes}: ${x.reason})`);
  // A standalone entry is written only when its own switch says write.
  const writable = r => r.entry && (!r.standalone || standaloneMode === 'write');
  if (write && (results.some(writable) || lifecycle.reopen.length)) {
    const { loadShows, saveShows } = createShowsWriteGuard(SHOWS_PATH);
    const snapshot = loadShows();
    const today = new Date().toISOString().slice(0, 10);
    for (const x of lifecycle.reopen) {
      const show = snapshot.shows.find(s => s.id === x.id);
      // Re-check under the lock: only the closing the evidence was read against.
      if (!show || show.category !== 'tour' || show.closingDate !== x.closingDate) continue;
      const blocked = reopenBlocker(show, toursOfTitle(show.title, snapshot.shows), x.resumes);
      if (blocked) { console.log(`${x.id}: not reopened: ${blocked}`); continue; }
      if (reopenTour(show, x, today)) reopened.push(x.id);
    }
    for (const r of results.filter(writable)) {
      // Re-check under the write lock: another run may have added it, or a
      // tour of the title may have been added or reopened meanwhile.
      if (snapshot.shows.some(s => s.id === r.entry.id)) continue;
      const parentNow = r.parentId ? snapshot.shows.find(s => s.id === r.parentId) : null;
      // A parent that has gone since is not a reason to fall back to a standalone entry for the same tour.
      if (r.parentId && !parentNow) { console.log(`  ${r.entry.id} skipped under lock: parent ${r.parentId} is gone`); continue; }
      const recheck = buildTourEntry({ parent: parentNow || null, ...(parentNow ? {} : { title: r.title, type: r.type }), shows: snapshot.shows, decision: { write: { openingDate: r.entry.openingDate, closingDate: r.entry.closingDate }, notes: r.notes, launchSource: r.launchSource }, roundupUrl: r.roundupUrl, scheduleUrl: r.scheduleUrl, retiredIds, knownEnds: r.knownEnds });
      if (recheck.skip) { console.log(`  ${r.entry.id} skipped under lock: ${recheck.skip}`); continue; }
      snapshot.shows.push(r.entry);
      created.push(r.entry.id);
    }
    if (created.length || reopened.length) saveShows(snapshot);
    if (created.length) {
      const now = new Date().toISOString();
      const next = rows.map(row => {
        const hit = results.find(x => x.candidate === candidateKey(row) && x.entry && created.includes(x.entry.id));
        if (hit) return { ...row, createdTourId: hit.entry.id, createdAt: now };
        // The BWW roundup that backed a standalone tour settles with it.
        const backed = results.find(x => x.entry && created.includes(x.entry.id) && x.roundupUrl && row.roundupUrl === x.roundupUrl && String(row.key || '').startsWith('roundup:'));
        return backed ? { ...row, createdTourId: backed.entry.id, createdAt: now } : row;
      });
      fs.writeFileSync(CANDIDATES, JSON.stringify(next, null, 2) + '\n');
    }
  }

  writeAudit({ mode: write ? 'write' : 'report', standaloneMode, created, reopened, results });
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `created=${created.join(',')}\nreopened=${reopened.join(',')}\n`);
  const wouldCreate = results.filter(r => r.entry);
  console.log(`\n${write ? `Created ${created.length}` : `${wouldCreate.length} would be created`}${write && wouldCreate.length > created.length ? ` (${wouldCreate.length - created.length} more reported only: standalone mode ${standaloneMode})` : ''}; ${results.filter(r => r.skip).length} stay suggestions.`);
  if (reopened.length) console.log(`Reopened ${reopened.length}: ${reopened.join(', ')}`);
}

/**
 * A closed tour its schedule page lists again, with history saying it is the
 * same tour (tour-discovery.js lifecyclePlan): back from a layoff. Clears the
 * closing so the daily jobs fetch its new dates and close it again from the
 * schedule when it really ends (enrich-tour-dates.js). Mutates show.
 * @returns {boolean} changed
 */
function reopenTour(show, facts, today) {
  if (!show.closingDate) return false;
  const note = `reopened ${today} (BRO-4724): closed ${facts.closingDate}, Tours To You lists it again from ${facts.resumes}; ${facts.reason}`;
  // The one chokepoint for closingDate writes; it honors humanCorrectedClosingDate.
  if (!writeClosingDate(show, null, note, { todayStr: today })) return false;
  show.status = show.openingDate && show.openingDate > today ? 'upcoming' : 'open';
  // Keep what was written before (hand notes on why it closed).
  show.statusSource = show.statusSource ? `${show.statusSource} | ${note}` : note;
  return true;
}

module.exports = { reopenTour };

if (require.main === module) {
  main()
    .catch((e) => { console.error(e); process.exitCode = 1; })
    .finally(() => require('./lib/scraper').cleanup().catch(() => {}).finally(() => process.exit(process.exitCode || 0)));
}
