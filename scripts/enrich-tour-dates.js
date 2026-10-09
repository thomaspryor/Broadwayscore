#!/usr/bin/env node
/**
 * enrich-tour-dates.js (BRO-4262): fill national-tour launch and closing dates.
 *
 * For every category:'tour' show missing a date, reads the tour's engagement
 * list from Tours To You and the show's Wikipedia article, and writes only what
 * scripts/lib/tour-schedule.js decideTourDates allows: a launch Wikipedia also
 * names, and a close backed by a positive signal. Closing writes go through
 * writeClosingDate (honours humanCorrectedClosingDate, stamps the source).
 * Status changes are left to update-show-status.js, which is date-driven.
 *
 * Writes data/audit/tour-dates.json every run: per tour, what was written and
 * any problem (a schedule page that parsed to nothing, a stored launch that
 * disagrees with the schedule). Problems never write.
 *
 * Usage:
 *   node scripts/enrich-tour-dates.js            report only (default)
 *   node scripts/enrich-tour-dates.js --write    write shows.json
 *   node scripts/enrich-tour-dates.js --show=ID  one tour
 * TOUR_DATES_MODE=off|report|write (repo variable) wins; unset = report-only
 * until tour-automation-mode.js LIVE_FROM, then write.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { tourAutomationMode } = require('./lib/tour-automation-mode');
const { parseTimeBudgetMin, createRunBudget } = require('./lib/run-budget');
const { decideTourDates, scheduleSlugs, parseTourSchedule } = require('./lib/tour-schedule');
const { fetchText, fetchSchedule } = require('./lib/tours-to-you');
const { writeClosingDate } = require('./lib/closing-date-guard');
const { createShowsWriteGuard } = require('./lib/shows-write-guard');
const { toursOfTitle } = require('./lib/tour-family');

/**
 * Where an earlier tour of the title closed before this one launched: the
 * page is split there, as create-tour-entries.js split it when it created this
 * tour, so a tour that follows a closed one on the same page never takes the
 * closed one's rows or launch (BRO-4724 ship-check).
 */
function earlierClosings(tour, shows) {
  if (!tour.openingDate) return [];
  return toursOfTitle(tour.title, shows)
    .filter(t => t.id !== tour.id && t.closingDate && String(t.closingDate).slice(0, 10) < tour.openingDate)
    .map(t => String(t.closingDate).slice(0, 10));
}
const { applyTourInheritance } = require('./lib/tour-family');

const ROOT = path.join(__dirname, '..');
const SHOWS_PATH = path.join(ROOT, 'data', 'shows.json');
const AUDIT_PATH = path.join(ROOT, 'data', 'audit', 'tour-dates.json');
const WIKI_API = 'https://en.wikipedia.org/w/api.php';
const USER_AGENT = 'BroadwayScorecardBot/1.0 (https://broadwayscorecard.com; contact@broadwayscorecard.com)';
const SOURCE = 'tourstoyou+wikipedia';

const USAGE = `enrich-tour-dates.js — fill national-tour launch/closing dates (BRO-4262)
  --write       write shows.json (default: report only)
  --show=ID     one tour
  --time-budget-min=N  stop cleanly after N minutes
  TOUR_DATES_MODE=off  skip entirely`;

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': USER_AGENT }, timeout: 20000 }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject).on('timeout', function () { this.destroy(new Error('timeout')); });
  });
}

/**
 * The first candidate article that exists (and, unless requireTour is false,
 * mentions a tour), as { title, text } or null. `title` is the article's name
 * with its "(musical)" / "(play)" qualifier: the resolved name when it has one,
 * else the name that was asked for, so a redirect from "Clue (musical)" to
 * "Clue The Musical" still shows that a musical was guessed.
 * `requireTour: false` (BRO-4931) is only for telling what a page IS from its
 * infobox (tour-page-class.js); such text never feeds a date decision, since the
 * first article that exists can be a different work (Clue -> the 1997 musical).
 */
async function fetchWikiArticle(title, { requireTour = true } = {}) {
  const titles = [`${title} (musical)`, `${title} (play)`, title];
  const url = `${WIKI_API}?action=query&titles=${encodeURIComponent(titles.join('|'))}&prop=revisions&rvprop=content&rvslots=main&format=json&formatversion=2&redirects=1`;
  const data = await fetchJson(url);
  const pages = (data.query && data.query.pages) || [];
  const byTitle = new Map(pages.filter(p => !p.missing && p.revisions).map(p => [p.title, p.revisions[0].slots.main.content]));
  const redirects = new Map(((data.query && data.query.redirects) || []).map(r => [r.from, r.to]));
  const norm = new Map(((data.query && data.query.normalized) || []).map(n => [n.from, n.to]));
  for (const t of titles) {
    const resolved = redirects.get(norm.get(t) || t) || norm.get(t) || t;
    const text = byTitle.get(resolved);
    if (text && (!requireTour || /\btour\b/i.test(text))) return { title: /\((musical|play)\)\s*$/i.test(resolved) ? resolved : t, text };
  }
  return null;
}

/** Wikitext of the first candidate article that exists and mentions a tour, or ''. The dates' source. */
async function fetchWikiText(title) {
  const article = await fetchWikiArticle(title, { requireTour: true });
  return article ? article.text : '';
}


async function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }
  const mode = tourAutomationMode(process.env.TOUR_DATES_MODE);
  if (mode === 'off') {
    console.log('TOUR_DATES_MODE=off — skipping');
    // Still report, so the digest can tell "switched off" from "stopped running".
    fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true });
    fs.writeFileSync(AUDIT_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), mode: 'off', applied: [], tours: [] }, null, 2) + '\n');
    return;
  }
  const write = argv.includes('--write') && mode === 'write';
  const only = (argv.find(a => a.startsWith('--show=')) || '').split('=')[1] || null;
  const { fetchPage } = require('./lib/scraper');

  const shows = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8')).shows;
  const targets = shows.filter(s => s.category === 'tour' && (only ? s.id === only : (!s.openingDate || !s.closingDate)));
  console.log(`${targets.length} tour(s) to check${write ? '' : ' (report only)'}`);

  // Stop cleanly before the workflow's timeout; the rest waits for tomorrow.
  const budget = createRunBudget(parseTimeBudgetMin(argv));
  const results = [];
  for (const tour of targets) {
    if (budget.exceeded()) { console.log(`Time budget reached; ${targets.length - results.length} tour(s) left for the next run`); break; }
    console.log(`\n${tour.id}`);
    const { url, html } = await fetchSchedule(tour, fetchPage, { budget });
    let wiki = '';
    try { wiki = await fetchWikiText(tour.title); } catch (e) { console.log(`  wikipedia failed: ${e.message}`); }
    const decision = url
      ? decideTourDates(tour, html, wiki, new Date(), { cuts: earlierClosings(tour, shows) })
      : { write: {}, notes: [], problem: `no Tours To You page found (tried ${scheduleSlugs(tour).join(', ')}); set tourScheduleSlug on the entry` };
    for (const n of decision.notes) console.log(`  ${n}`);
    if (decision.problem) console.log(`  PROBLEM: ${decision.problem}`);
    console.log(`  would write: ${JSON.stringify(decision.write)}`);
    results.push({ id: tour.id, scheduleUrl: url, wikipedia: Boolean(wiki), ...decision });
  }

  const toWrite = results.filter(r => Object.keys(r.write).length);
  const applied = [];
  // One load/save under the write guard for everything this run writes, so the
  // inheritance and the dates can't come from two different snapshots.
  if (write && (toWrite.length || !only)) {
    const { loadShows, saveShows } = createShowsWriteGuard(SHOWS_PATH);
    const snapshot = loadShows();
    const byId = new Map(snapshot.shows.map(s => [s.id, s]));
    const today = new Date().toISOString().slice(0, 10);
    for (const r of toWrite) {
      const show = byId.get(r.id);
      if (!show) continue;
      const done = {};
      // Re-check under the write lock: never overwrite a date set meanwhile.
      if (r.write.openingDate && !show.openingDate) {
        show.openingDate = r.write.openingDate;
        show.openingDateSource = SOURCE;
        done.openingDate = r.write.openingDate;
      }
      if (r.write.closingDate && !show.closingDate && writeClosingDate(show, r.write.closingDate, SOURCE, { todayStr: today })) {
        done.closingDate = r.write.closingDate;
      }
      if (Object.keys(done).length) applied.push({ id: r.id, ...done });
    }
    // Tours take their Broadway parent's art and synopsis when they have none
    // (tour-family.js); here too so a newly created tour has them the same day.
    const inherited = only ? [] : applyTourInheritance(snapshot.shows);
    if (inherited.length) console.log(`Parent art/synopsis given to: ${inherited.join(', ')}`);
    if (applied.length || inherited.length) saveShows(snapshot);
  }

  fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true });
  fs.writeFileSync(AUDIT_PATH, JSON.stringify({
    generatedAt: new Date().toISOString(),
    mode: write ? 'write' : 'report',
    applied,
    tours: results.map(r => ({ id: r.id, scheduleUrl: r.scheduleUrl, wikipedia: r.wikipedia, wouldWrite: r.write, notes: r.notes, problem: r.problem || null })),
  }, null, 2) + '\n');
  console.log(`\n${write ? `Wrote ${applied.length} tour(s)` : `${toWrite.length} tour(s) would be written`}; ${results.filter(r => r.problem).length} problem(s). Audit: ${path.relative(ROOT, AUDIT_PATH)}`);
}

if (require.main === module) {
  // cleanup() closes any browser fetchPage opened; without it the success path hangs.
  main()
    .catch((e) => { console.error(e); process.exitCode = 1; })
    .finally(() => require('./lib/scraper').cleanup().catch(() => {}).finally(() => process.exit(process.exitCode || 0)));
}

module.exports = { fetchWikiText, fetchWikiArticle, fetchSchedule, fetchText, earlierClosings };
