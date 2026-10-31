#!/usr/bin/env node
/**
 * audit-postponed-shows.js (BRO-4913)
 *
 * Live sweep: open/previews shows with 0 reviews 48h+ past openingDate whose
 * official/TodayTix page shows a future launch date are postponed. Fetches the
 * pages via fetchPage and, with --demote, flips them to upcoming (shows.json
 * written through shows-write-guard). Decision logic:
 * scripts/lib/postponed-production-{detector,audit}.js.
 *
 * Usage: node scripts/audit-postponed-shows.js [--demote] [--fail-on-gap]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { createShowsWriteGuard } = require('./lib/shows-write-guard');
const { findPostponedShows } = require('./lib/postponed-production-audit');
const { evaluatePostponed } = require('./lib/postponed-production-detector');

const argv = process.argv.slice(2);
const DEMOTE = argv.includes('--demote');
const FAIL_ON_GAP = argv.includes('--fail-on-gap');
const DATA_DIR = path.join(__dirname, '..', 'data');

async function main() {
  if (hasHelpFlag(argv)) { console.log('Usage: node scripts/audit-postponed-shows.js [--demote] [--fail-on-gap]'); return; }
  const guard = createShowsWriteGuard(path.join(DATA_DIR, 'shows.json'));
  const showsData = guard.loadShows();
  let reviewsData = null;
  try { reviewsData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'reviews.json'), 'utf8')); } catch (e) { /* fail closed */ }
  const { fetchPage, cleanup } = require('./lib/scraper');
  const now = new Date();
  const res = await findPostponedShows(showsData, {
    now,
    reviewsData,
    demote: DEMOTE,
    getPageText: async (show) => {
      for (const url of [show.officialUrl, show.todaytixUrl].filter(Boolean)) {
        const r = await fetchPage(url);
        if (evaluatePostponed(show, { now, reviewCount: 0, pageText: r.content })) return r.content;
      }
      return null;
    },
  });
  console.log(`audit-postponed-shows: ${res.postponed.length} postponed show(s)${res.skipped ? ` (${res.skipped})` : ''}; ${res.fetchFailures} fetch failure(s)`);
  for (const p of res.postponed) console.log(`  - ${p.id} (${p.title}): ${p.reason}${p.demoted ? ' [demoted to upcoming]' : ''}`);
  if (DEMOTE && res.postponed.length > 0) guard.saveShows(showsData, { reason: 'BRO-4913 postponed demote' });
  try { await cleanup(); } catch (e) { /* no browser */ }
  if (FAIL_ON_GAP && res.postponed.length > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
