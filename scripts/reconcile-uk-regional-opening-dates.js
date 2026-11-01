#!/usr/bin/env node
/**
 * reconcile-uk-regional-opening-dates.js (BRO-6725)
 *
 * UK regional (and, BRO-6697, theatreinchicago) opening dates seeded from the first Guardian/census review are an upper
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
const { hasHelpFlag } = require('./lib/cli-help.js');
const root = path.join(__dirname, '..');
const { reconcileOpeningDate } = require('./lib/uk-regional-opening-date');
const { isUkRegionalVenue } = require('./lib/market-label');
const { isLocalOnlyShow } = require('./lib/local-market');

// BRO-6697: theatreinchicago rows are localOnly regional rows seeded the same way
// ('tic-first-review'); they stay in scope after a move re-stamps the source.
const isTicRow = (s) => s.discoverySource === 'theatreinchicago';

function plan(shows, reviews) {
  const by = {};
  for (const r of reviews) (by[r.showId] = by[r.showId] || []).push(r.publishDate);
  const moves = []; const manual = [];
  for (const s of shows) {
    if (s.category !== 'regional' || !(isTicRow(s) || (isUkRegionalVenue(s.venue) && !isLocalOnlyShow(s)))) continue;
    // A human-pinned date is restored by the shows write guard; never count it as moved.
    if (s.humanCorrectedOpeningDate) continue;
    const d = reconcileOpeningDate(s, by[s.id], { minReviews: isTicRow(s) ? 2 : 1 });
    if (d.action === 'move') moves.push({ show: s, ...d });
    else if (d.action === 'manual') manual.push({ show: s, ...d });
  }
  return { moves, manual };
}

if (require.main === module) {
  if (hasHelpFlag(process.argv.slice(2))) {
    console.log('Usage: node scripts/reconcile-uk-regional-opening-dates.js [--plan=bro-N]\nPrints how many review-seeded UK regional opening dates should move; --plan writes pending-fix plans.');
    process.exit(0);
  }
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
      // openingDate edits stamp a human pin that would block later press-night sources: clear it.
      actions.push({ ...base, field: 'humanCorrectedOpeningDate', newValue: null, description: 'Clear the pin so a press-night source can still refine this date' });
    }
    const file = path.join(os.tmpdir(), `reconcile-opening-${process.pid}.json`);
    fs.writeFileSync(file, JSON.stringify(actions));
    execFileSync('node', [path.join(__dirname, 'new-fix-plan.js'), `--id=${arg.slice(7)}`, '--summary=UK regional + theatreinchicago: move review-seeded opening dates to the earliest review date', `--actions=${file}`], { stdio: 'inherit' });
  }
}
// CI path (BRO-6725): the daily status job applies the same moves to shows that were
// seeded after the one-off plans, so a review-seeded date never stays after a review.
function applyMoves(shows, reviews) {
  const { moves } = plan(shows, reviews);
  const { newDuplicateFindings } = require('./lib/shows-duplicate-rule');
  const before = shows.map((x) => ({ ...x }));
  for (const m of moves) {
    m.prev = { openingDate: m.show.openingDate, openingDateSource: m.show.openingDateSource };
    m.show.openingDate = m.openingDate;
    m.show.openingDateSource = m.openingDateSource;
  }
  // A date move can bring two rows of one run inside the duplicate rule's window and the
  // shows write guard would then refuse the whole save. Leave those shows alone; they stay
  // visible in the strict check until a person decides which row to keep.
  const bad = new Set();
  for (const f of newDuplicateFindings(before, shows)) { bad.add(f.show.id); bad.add(f.existing.id); }
  const kept = [];
  for (const m of moves) {
    if (bad.has(m.show.id)) { Object.assign(m.show, m.prev); m.skippedDuplicate = true; } else kept.push(m);
  }
  return kept;
}
module.exports = { plan, applyMoves };
