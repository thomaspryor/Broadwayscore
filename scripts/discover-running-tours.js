#!/usr/bin/env node
/**
 * discover-running-tours.js (BRO-4325): find national tours of Broadway shows
 * that are on the road now, from Tours To You's full list of show pages.
 *
 * Records each as a candidate in data/audit/tour-roundup-candidates.json
 * (source 'tourstoyou'); create-tour-entries.js turns a candidate into a tour
 * entry only when Wikipedia confirms the launch. create-tour-entries.js calls
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
const { PAGES_API, slugKeys, titleKeys, runningTourCandidate, dedupeCandidates } = require('./lib/tour-discovery');
const { recordTourCandidates } = require('./lib/tour-roundup-candidate');
const { STALE_DAYS, orderForCheck, nextCoverage, stalePages } = require('./lib/tours-to-you-coverage');

const ROOT = path.join(__dirname, '..');
const SHOWS_PATH = path.join(ROOT, 'data', 'shows.json');
const CANDIDATES = path.join(ROOT, 'data', 'audit', 'tour-roundup-candidates.json');

const USAGE = `discover-running-tours.js — find national tours on the road now (BRO-4325)
  --record   record candidates (default: report only)`;

/**
 * Every show page on Tours To You (WordPress pages API, 100 a page): slugs,
 * plus each page's last edit (`modified`) so edited pages are read first.
 * Returns an array of slugs carrying a `.modified` map.
 */
async function listShowPages(fetchText) {
  const out = [];
  const modified = {};
  for (let page = 1; page <= 50; page++) {
    let rows;
    try {
      rows = JSON.parse(await fetchText(`${PAGES_API}&page=${page}`));
    } catch (e) {
      // WordPress answers past the last page with an HTTP 400.
      if (page > 1 && /HTTP 400/.test(e.message)) break;
      throw e;
    }
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows) {
      if (!r.slug) continue;
      out.push(r.slug);
      // modified_gmt is UTC without a zone suffix (plain `modified` is site-local).
      if (r.modified_gmt) modified[r.slug] = `${r.modified_gmt}Z`;
    }
    if (rows.length < 100) break;
  }
  const slugs = [...new Set(out)];
  slugs.modified = modified;
  return slugs;
}

/**
 * Reads the Broadway-titled show pages, least-recently-read first (BRO-4725),
 * until the budget runs out; the rest wait for the next run, which starts
 * with them. `coverage` is the previous run's map (tours-to-you-coverage.js);
 * the returned one stamps every page read now.
 * @param {{shows: object[], budget?: object, coverage?: object, fallback?: Function, log?: Function}} args
 * @returns {Promise<{candidates: object[], ambiguous: string[], checked: number, pages: number, eligible: number, coverage: object, rateLimited: number, failed: number}>}
 */
async function discoverRunningTours({ shows, budget = null, coverage = {}, fallback = null, log = console.log }) {
  const { politeFetchText, stats } = require('./lib/tours-to-you');
  const fetchText = url => politeFetchText(url, { budget, log });
  const slugs = await listShowPages(fetchText);
  // Only pages whose title is a Broadway show are worth a fetch.
  const broadwayKeys = new Set();
  for (const s of shows) if ((s.category || 'broadway') === 'broadway') for (const k of titleKeys(s.title)) broadwayKeys.add(k);
  const worth = slugs.filter(slug => slugKeys(slug).some(k => broadwayKeys.has(k)));
  log(`Tours To You: ${slugs.length} show pages, ${worth.length} with a Broadway title`);
  if (slugs.length < 100) throw new Error(`only ${slugs.length} show pages listed; the pages API may have changed`);

  const order = orderForCheck(worth, coverage, slugs.modified || {});
  const found = [];
  const read = [];
  let failed = 0;
  const limitedBefore = stats.rateLimited;
  for (const slug of order) {
    if (budget && budget.exceeded()) { log(`Time budget reached after ${read.length} page(s); ${order.length - read.length - failed} wait for the next run, which starts with them`); break; }
    const scheduleUrl = `https://tourstoyou.org/shows/${slug}/`;
    let html = '';
    try { html = await politeFetchText(scheduleUrl, { budget, fallback, log }); } catch (e) { failed++; log(`  ${slug}: ${e.message}`); continue; }
    read.push(slug);
    const r = runningTourCandidate({ slug, scheduleUrl, html, shows });
    if (r.candidate) {
      log(`  running: ${slug} -> ${r.candidate.broadwayShowId} since ${r.candidate.segmentStart}`);
      found.push(r.candidate);
    }
  }
  const next = nextCoverage(coverage, worth, read);
  const stale = stalePages(next);
  log(`Read ${read.length} of ${worth.length} page(s) this run (${failed} failed, ${stats.rateLimited - limitedBefore} rate-limited answer(s)); ${stale.length} not read in over ${STALE_DAYS} days`);
  const { candidates, ambiguous } = dedupeCandidates(found);
  for (const a of ambiguous) log(`  ambiguous (two tours running at once), left for the owner: ${a}`);
  return { candidates, ambiguous, checked: read.length, failed, pages: slugs.length, eligible: worth.length, coverage: next, rateLimited: stats.rateLimited - limitedBefore };
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }
  const shows = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8')).shows;
  // Standalone: read in the landing job's order, but leave its state alone.
  let coverage = {};
  try { coverage = (JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'audit', 'tour-autocreate.json'), 'utf8')).discovery || {}).coverage || {}; } catch { /* first run */ }
  const { candidates } = await discoverRunningTours({ shows, coverage });
  console.log(`\n${candidates.length} running tour(s) of Broadway shows`);
  if (argv.includes('--record')) {
    const n = recordTourCandidates(CANDIDATES, candidates);
    console.log(`Recorded; ${n} candidate row(s) tracked in ${path.relative(ROOT, CANDIDATES)}`);
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}

module.exports = { discoverRunningTours, listShowPages };
