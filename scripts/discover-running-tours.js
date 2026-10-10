#!/usr/bin/env node
/**
 * discover-running-tours.js (BRO-4325): find national tours that are on the
 * road now, from Tours To You's full list of show pages.
 *
 * Since BRO-4931 every page is read, not only those titled like a Broadway
 * show: tours of Off-Broadway, regional and West End shows and standalone
 * touring shows count too. Each page is classified first (tour-page-class.js);
 * concerts, circus, aggregators, templates and company pages are skipped, and
 * only a production becomes a candidate.
 *
 * Records each as a candidate in data/audit/tour-roundup-candidates.json
 * (source 'tourstoyou'); create-tour-entries.js turns a candidate into a tour
 * entry only when the launch is confirmed. create-tour-entries.js calls
 * discoverRunningTours() itself before creating, so the daily landing job
 * needs no extra step. Standalone it only reports.
 *
 * Usage:
 *   node scripts/discover-running-tours.js           report what it would record
 *   node scripts/discover-running-tours.js --record  record the candidates
 */

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { listShowPages, runningTourCandidate, dedupeCandidates, candidateKey } = require('./lib/tour-discovery');
const { classifyTourPage, loadTourPageClasses, SKIPPED_CLASSES } = require('./lib/tour-page-class');
const { recordTourCandidates } = require('./lib/tour-roundup-candidate');
const { STALE_DAYS, orderForCheck, nextCoverage, stalePages } = require('./lib/tours-to-you-coverage');

const ROOT = path.join(__dirname, '..');
const SHOWS_PATH = path.join(ROOT, 'data', 'shows.json');
const CANDIDATES = path.join(ROOT, 'data', 'audit', 'tour-roundup-candidates.json');

const USAGE = `discover-running-tours.js — find national tours on the road now (BRO-4325)
  --record   record candidates (default: report only)`;

/**
 * Reads every show page the classifier does not deny up front (an override or
 * a template/company/event slug rule), least-recently-read first (BRO-4725),
 * until the budget runs out; the rest wait for the next run, which starts
 * with them. `coverage` is the previous run's map (tours-to-you-coverage.js);
 * the returned one stamps every page read now. Denied pages are not fetched and
 * drop out of coverage, so they never count as stale.
 * @param {{shows: object[], budget?: object, coverage?: object, fallback?: Function, log?: Function, overrides?: object}} args
 * @returns {Promise<{candidates: object[], ambiguous: string[], reopen: object[], undecided: object[], checked: number, pages: number, eligible: number, coverage: object, rateLimited: number, failed: number, classes: object, denied: object, autoClassified: object[]}>}
 */
async function discoverRunningTours({ shows, budget = null, coverage = {}, fallback = null, log = console.log, overrides = loadTourPageClasses() }) {
  const { politeFetchText, stats, looksLikeShowPage } = require('./lib/tours-to-you');
  const fetchText = url => politeFetchText(url, { budget, log });
  const slugs = await listShowPages(fetchText);
  const titles = slugs.titles || {};
  if (slugs.length < 100) throw new Error(`only ${slugs.length} show pages listed; the pages API may have changed`);
  // Pages a person or a slug rule has already ruled out are not worth a fetch.
  const denied = {};
  const worth = slugs.filter(slug => {
    const c = classifyTourPage({ slug, pageTitle: titles[slug] || null, shows, overrides });
    if (!SKIPPED_CLASSES.has(c.class)) return true;
    denied[c.class] = (denied[c.class] || 0) + 1;
    return false;
  });
  log(`Tours To You: ${slugs.length} show pages, ${worth.length} to read (${Object.entries(denied).map(([k, n]) => `${n} ${k}`).join(', ') || 'none'} ruled out without a fetch)`);

  const order = orderForCheck(worth, coverage, slugs.modified || {});
  const found = [];
  const reopen = [];
  const undecided = [];
  const read = [];
  const classes = {};
  // Pages the structure rule (not a person) ruled out: add them to data/tour-page-classes.json to stop re-reading them.
  const autoClassified = [];
  let failed = 0;
  const limitedBefore = stats.rateLimited;
  for (const slug of order) {
    if (budget && budget.exceeded()) { log(`Time budget reached after ${read.length} page(s); ${order.length - read.length - failed} wait for the next run, which starts with them`); break; }
    const scheduleUrl = `https://tourstoyou.org/shows/${slug}/`;
    let html = '';
    try { html = await politeFetchText(scheduleUrl, { budget, fallback, log }); } catch (e) { failed++; log(`  ${slug}: ${e.message}`); continue; }
    // A challenge or error body must not stamp the page as read.
    if (!looksLikeShowPage(html)) { failed++; log(`  ${slug}: answer is not a Tours To You page`); continue; }
    read.push(slug);
    const r = runningTourCandidate({ slug, scheduleUrl, html, shows, overrides, pageTitle: titles[slug] || null });
    if (r.pageClass) {
      classes[r.pageClass.class] = (classes[r.pageClass.class] || 0) + 1;
      if (r.pageClass.source === 'structure') autoClassified.push({ slug, class: r.pageClass.class, reason: r.pageClass.reason });
    }
    // A closed tour the page lists again (BRO-4724): back from a layoff, or
    // the page doesn't say. Deduped by tour id (two pages, one tour).
    for (const x of (r.lifecycle && r.lifecycle.reopen) || []) if (!reopen.some(y => y.id === x.id)) reopen.push({ ...x, scheduleUrl });
    for (const x of (r.lifecycle && r.lifecycle.undecided) || []) if (!undecided.some(y => y.id === x.id)) undecided.push({ ...x, scheduleUrl });
    if (r.candidate) {
      log(`  running: ${slug} -> ${candidateKey(r.candidate)}${r.candidate.needsClassification ? ' (needs classification)' : ''} since ${r.candidate.segmentStart}`);
      found.push(r.candidate);
    }
  }
  const next = nextCoverage(coverage, worth, read);
  const stale = stalePages(next);
  log(`Read ${read.length} of ${worth.length} page(s) this run (${failed} failed, ${stats.rateLimited - limitedBefore} rate-limited answer(s)); ${stale.length} not read in over ${STALE_DAYS} days`);
  log(`Classes of the pages read: ${Object.entries(classes).map(([k, n]) => `${n} ${k}`).join(', ') || 'none'}`);
  for (const a of autoClassified) log(`  ${a.slug} was set aside as an ${a.class} by its structure (${a.reason}). If it is a list of different shows, add it to data/tour-page-classes.json as ${a.class} to stop reading it; if it is one production with several companies, add it there as a production instead`);
  const { candidates, ambiguous } = dedupeCandidates(found);
  for (const a of ambiguous) log(`  ambiguous (two tours running at once), left for the owner: ${a}`);
  return { candidates, ambiguous, reopen, undecided, checked: read.length, failed, pages: slugs.length, eligible: worth.length, coverage: next, rateLimited: stats.rateLimited - limitedBefore, classes, denied, autoClassified };
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }
  const shows = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8')).shows;
  // Standalone: read in the landing job's order, but leave its state alone.
  let coverage = {};
  try { coverage = (JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'audit', 'tour-autocreate.json'), 'utf8')).discovery || {}).coverage || {}; } catch { /* first run */ }
  const { candidates } = await discoverRunningTours({ shows, coverage });
  console.log(`\n${candidates.length} running tour(s)`);
  if (argv.includes('--record')) {
    const n = recordTourCandidates(CANDIDATES, candidates);
    console.log(`Recorded; ${n} candidate row(s) tracked in ${path.relative(ROOT, CANDIDATES)}`);
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}

module.exports = { discoverRunningTours, listShowPages };
