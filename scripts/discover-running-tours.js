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
const { PAGES_API, slugKey, titleKeys, runningTourCandidate, dedupeCandidates } = require('./lib/tour-discovery');
const { recordTourCandidates } = require('./lib/tour-roundup-candidate');

const ROOT = path.join(__dirname, '..');
const SHOWS_PATH = path.join(ROOT, 'data', 'shows.json');
const CANDIDATES = path.join(ROOT, 'data', 'audit', 'tour-roundup-candidates.json');

const USAGE = `discover-running-tours.js — find national tours on the road now (BRO-4325)
  --record   record candidates (default: report only)`;

/** Every show page slug on Tours To You (WordPress pages API, 100 a page). */
async function listShowPages(fetchText) {
  const out = [];
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
    out.push(...rows.map(r => r.slug).filter(Boolean));
    if (rows.length < 100) break;
  }
  return [...new Set(out)];
}

/**
 * @param {{shows: object[], budget?: {exceeded: () => boolean}, log?: Function}} args
 * @returns {Promise<{candidates: object[], ambiguous: string[], checked: number, pages: number}>}
 */
async function discoverRunningTours({ shows, budget = null, log = console.log }) {
  const { fetchText } = require('./enrich-tour-dates');
  const slugs = await listShowPages(fetchText);
  // Only pages whose title is a Broadway show are worth a fetch.
  const broadwayKeys = new Set();
  for (const s of shows) if ((s.category || 'broadway') === 'broadway') for (const k of titleKeys(s.title)) broadwayKeys.add(k);
  const worth = slugs.filter(slug => broadwayKeys.has(slugKey(slug)));
  log(`Tours To You: ${slugs.length} show pages, ${worth.length} with a Broadway title`);
  if (slugs.length < 100) throw new Error(`only ${slugs.length} show pages listed; the pages API may have changed`);

  const found = [];
  let checked = 0;
  for (const slug of worth) {
    if (budget && budget.exceeded()) { log(`Time budget reached after ${checked} page(s); the rest wait for the next run`); break; }
    const scheduleUrl = `https://tourstoyou.org/shows/${slug}/`;
    let html = '';
    try { html = await fetchText(scheduleUrl); } catch (e) { log(`  ${slug}: ${e.message}`); continue; }
    checked++;
    const r = runningTourCandidate({ slug, scheduleUrl, html, shows });
    if (r.candidate) {
      log(`  running: ${slug} -> ${r.candidate.broadwayShowId} since ${r.candidate.segmentStart}`);
      found.push(r.candidate);
    }
  }
  const { candidates, ambiguous } = dedupeCandidates(found);
  for (const a of ambiguous) log(`  ambiguous (two tours running at once), left for the owner: ${a}`);
  return { candidates, ambiguous, checked, pages: slugs.length };
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }
  const shows = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8')).shows;
  const { candidates } = await discoverRunningTours({ shows });
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
