#!/usr/bin/env node
/**
 * clear-wrong-show-roundup-excerpts.js: undo what an archived westendtheatre.com
 * round-up about ANOTHER show planted on this show's review files (BRO-3564).
 *
 * The archive filed under My Neighbour Totoro was the Wendy & Peter Pan
 * round-up; every row matched a Totoro critic file by outlet + name, so ten
 * files carried a Peter Pan westEndTheatreExcerpt (and one a Peter Pan
 * westEndTheatreScore). New writes are blocked by aggregator-page-show-guard
 * at every writer; this cleans what was written before.
 *
 * For each archive page that roundupExcerptsAboutShow rejects: on that show's
 * files, remove westEndTheatreExcerpt when it is one of the page's excerpts,
 * the westEndTheatreScore that came with it, and the sourceless aggregatorStars
 * relayed from that row's star; queue a rescore when the
 * file's score came from the WET star. Then delete the archive page so no
 * reader replays it (the guarded writers refetch and re-judge).
 *
 * Usage:
 *   node scripts/clear-wrong-show-roundup-excerpts.js [--show=ID] [--apply]
 * Dry run by default. Idempotent.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { roundupExcerptsAboutShow, planWrongShowRoundupClear: planRecordEdit } = require('./lib/aggregator-page-show-guard');
const { safeWriteReview } = require('./lib/review-write-guard');

const USAGE = `clear-wrong-show-roundup-excerpts.js: remove excerpts an archived round-up about another show planted (BRO-3564).

Usage:
  node scripts/clear-wrong-show-roundup-excerpts.js [--show=ID] [--apply]
  node scripts/clear-wrong-show-roundup-excerpts.js --help, -h    print this usage and exit
`;
if (hasHelpFlag(process.argv)) { console.log(USAGE); process.exit(0); }

const APPLY = process.argv.includes('--apply');
const ONLY_SHOW = (process.argv.find(a => a.startsWith('--show=')) || '').split('=')[1] || null;
const ROOT = path.join(__dirname, '..');
const REVIEW_DIR = process.env.REVIEW_TEXTS_DIR || path.join(ROOT, 'data', 'review-texts');
// The archive lives in data/aggregator-archive (CI) or inside the review-texts
// clone (cloud sessions); use whichever exists.
const ARCHIVE_DIR = [path.join(ROOT, 'data', 'aggregator-archive', 'westendtheatre'),
  path.join(REVIEW_DIR, 'aggregator-archive', 'westendtheatre')]
  .find(p => fs.existsSync(p) && fs.readdirSync(p).some(f => f.endsWith('.json')));
const SHOWS_PATH = process.env.SHOWS_PATH || path.join(ROOT, 'data', 'shows.json');

function main() {
  if (!ARCHIVE_DIR) { console.log('No westendtheatre archive found.'); return; }
  const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const shows = Array.isArray(showsData.shows) ? showsData.shows : Object.values(showsData.shows || showsData);
  const byId = Object.fromEntries(shows.map(s => [s.id, s]));
  let pages = 0, files = 0;
  for (const f of fs.readdirSync(ARCHIVE_DIR).filter(x => x.endsWith('.json'))) {
    const showId = f.replace(/\.json$/, '');
    if (ONLY_SHOW && showId !== ONLY_SHOW) continue;
    const show = byId[showId];
    if (!show) continue;
    let page;
    try { page = JSON.parse(fs.readFileSync(path.join(ARCHIVE_DIR, f), 'utf8')); } catch { continue; }
    const rows = page.reviews || page.ratings || [];
    const check = roundupExcerptsAboutShow(rows, show, { pageTitle: page.wpTitle });
    if (check.ok) continue;
    pages++;
    console.log(`${showId}: page rejected (${check.reason})`);
    const dir = path.join(REVIEW_DIR, showId);
    for (const rf of fs.existsSync(dir) ? fs.readdirSync(dir).filter(x => x.endsWith('.json')) : []) {
      const fp = path.join(dir, rf);
      let rec;
      try { rec = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { continue; }
      const next = planRecordEdit(rec, rows);
      if (!next) continue;
      files++;
      console.log(`  ${APPLY ? 'cleared' : 'would clear'} ${showId}/${rf}${next.needsRescore && !rec.needsRescore ? ' (rescore queued)' : ''}`);
      if (APPLY) safeWriteReview(fp, next, { force: true });
    }
    if (APPLY) {
      fs.unlinkSync(path.join(ARCHIVE_DIR, f));
      console.log(`  deleted archive page ${f}`);
    }
  }
  console.log(`${APPLY ? 'APPLIED' : 'DRY RUN'}: ${pages} page(s) rejected, ${files} file(s) ${APPLY ? 'cleared' : 'to clear'}`);
}

if (require.main === module) main();
