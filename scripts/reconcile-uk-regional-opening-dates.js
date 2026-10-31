#!/usr/bin/env node
/**
 * reconcile-uk-regional-opening-dates.js (BRO-6725)
 *
 * UK regional opening dates seeded from the first Guardian/census review are an upper
 * bound on press night. Where any outlet reviewed earlier, move the date to the earliest
 * full-date review (source 'first-review-date', still unconfirmed so Playbill/theatremonkey
 * can overwrite). Gaps wider than 14 days are listed, never applied.
 *
 *   node scripts/reconcile-uk-regional-opening-dates.js                 # report
 *   node scripts/reconcile-uk-regional-opening-dates.js --plan=bro-6725 # also write data/pending-fixes plan(s)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const root = path.join(__dirname, '..');
const { reconcileOpeningDate } = require('./lib/uk-regional-opening-date');
const { isUkRegionalVenue } = require('./lib/market-label');
const { isLocalOnlyShow } = require('./lib/local-market');

function plan(shows, reviews) {
  const by = {};
  for (const r of reviews) (by[r.showId] = by[r.showId] || []).push(r.publishDate);
  const moves = []; const manual = [];
  for (const s of shows) {
    if (s.category !== 'regional' || !isUkRegionalVenue(s.venue) || isLocalOnlyShow(s)) continue;
    const d = reconcileOpeningDate(s, by[s.id]);
    if (d.action === 'move') moves.push({ show: s, ...d });
    else if (d.action === 'manual') manual.push({ show: s, ...d });
  }
  return { moves, manual };
}

if (require.main === module) {
  const raw = require(path.join(root, 'data/shows.json'));
  const shows = Array.isArray(raw) ? raw : raw.shows;
  const { moves, manual } = plan(shows, require(path.join(root, 'data/reviews.json')).reviews);
  console.log(`move: ${moves.length}, manual: ${manual.length}`);
  for (const m of manual) console.log(`  manual ${m.show.id}: ${m.reason}`);
  const arg = process.argv.find((a) => a.startsWith('--plan='));
  if (arg && moves.length) {
    const actions = [];
    for (const m of moves) {
      const base = { type: 'data-edit', file: 'shows.json', showId: m.show.id };
      actions.push({ ...base, field: 'openingDate', newValue: m.openingDate, description: `Earliest review is ${m.gapDays}d before the review-seeded opening date` });
      actions.push({ ...base, field: 'openingDateSource', newValue: m.openingDateSource, description: 'Opening date now the earliest review date (unconfirmed upper bound)' });
    }
    const file = path.join(os.tmpdir(), `reconcile-opening-${process.pid}.json`);
    fs.writeFileSync(file, JSON.stringify(actions));
    execFileSync('node', [path.join(__dirname, 'new-fix-plan.js'), `--id=${arg.slice(7)}`, '--summary=UK regional: move review-seeded opening dates to the earliest review date', `--actions=${file}`], { stdio: 'inherit' });
  }
}
module.exports = { plan };
