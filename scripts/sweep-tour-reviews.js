#!/usr/bin/env node
/**
 * Move national-tour reviews from Broadway show folders to their tour entry (BRO-4211).
 *
 * A tour review for a show that has a tour entry lands on the Broadway show,
 * flagged wrongProduction and excluded from its score. This sweep moves each
 * one to the tour, under the rules in scripts/lib/tour-backfill.js
 * (classifyTourBackfill / prepareTourMove / planTourSweep).
 *
 * Intake now files tour-stop reviews on the tour directly (market-routing
 * tourDecision, BRO-4262), so this is the mop-up for anything that still lands
 * on the Broadway show. rebuild-reviews.yml runs it daily with --auto.
 *
 * Usage:
 *   node scripts/sweep-tour-reviews.js --all                  # dry-run every tour
 *   node scripts/sweep-tour-reviews.js --tour=<tour id>       # dry-run one tour
 *   node scripts/sweep-tour-reviews.js --auto                 # scheduled: every tour, move unless over the cap
 *   ... add --execute to move. --reviewTextsDir=<dir> overrides data/review-texts.
 *
 * Hard stop (--auto): a tour whose sweep would move more than 20 files, or more
 * than 10% of a Broadway folder, moves nothing and is reported instead. A mop-up
 * should move a handful; a flood means intake or a rule broke, and the pre-mortem
 * showed a wrong rule could empty a long-running Broadway page. The report is
 * data/audit/tour-sweep.json. TOUR_SWEEP=off skips; TOUR_SWEEP=report never moves.
 *
 * Each moved file records its origin (routedFromShowId, routedAt, routedReason,
 * routedPriorVerdicts), which is the undo record; there is no separate manifest.
 */

const fs = require('fs');
const path = require('path');
const { safeWriteReview } = require('./lib/review-write-guard');
const { prepareTourMove, planTourSweep, decideTourSweep, sweepHoldReason } = require('./lib/tour-backfill');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `sweep-tour-reviews.js — move national-tour reviews from Broadway show folders to their tour entry.

Usage:
  node scripts/sweep-tour-reviews.js --all | --tour=<tour id> [--execute] [--reviewTextsDir=<dir>]
  node scripts/sweep-tour-reviews.js --auto [--max-moves=20]   scheduled mop-up with a hard stop
  node scripts/sweep-tour-reviews.js --help, -h    print this usage and exit
`;

const ROOT = path.join(__dirname, '..');
const flag = (name) => {
  const a = process.argv.find(x => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
};

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function main() {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const auto = process.argv.includes('--auto');
  if (auto && process.env.TOUR_SWEEP === 'off') { console.log('TOUR_SWEEP=off — skipping'); return; }
  const execute = (process.argv.includes('--execute') || auto) && process.env.TOUR_SWEEP !== 'report';
  const all = process.argv.includes('--all') || auto;
  const maxMoves = Number(flag('max-moves')) || 20;
  const only = flag('tour');
  if (!all && !only) { console.error(USAGE); process.exit(2); }
  const reviewTextsDir = flag('reviewTextsDir') || path.join(ROOT, 'data', 'review-texts');
  const raw = readJson(path.join(ROOT, 'data', 'shows.json'));
  const shows = Array.isArray(raw) ? raw : (raw && raw.shows) || [];
  const plans = planTourSweep(shows).filter(p => all || p.tourId === only);
  if (only && plans.length === 0) {
    console.error(`${only} must exist in shows.json with category 'tour' and a tourOf that exists`); process.exit(2);
  }

  const listFiles = (showId) => {
    const dir = path.join(reviewTextsDir, showId);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(n => n.endsWith('.json')).sort()
      .map(file => ({ file, data: readJson(path.join(dir, file)) }));
  };

  let totalMoved = 0;
  const report = [];
  for (const plan of plans) {
    const toDir = path.join(reviewTextsDir, plan.tourId);
    const counts = {};
    const at = new Date().toISOString();
    const rows = decideTourSweep(plan, listFiles);
    const pending = rows.filter(r => r.key === 'tour-review');
    const holdReason = auto ? sweepHoldReason(pending, plan.fromIds, id => listFiles(id).length, { maxMoves }) : null;
    const overCap = Boolean(holdReason);
    if (overCap) {
      console.log(`::warning::tour sweep held for ${plan.tourId}: ${holdReason}. Nothing moved; review with node scripts/sweep-tour-reviews.js --tour=${plan.tourId}`);
    }
    for (const { fromId, file, data, key: decided } of rows) {
      let key = decided;
      if (key === 'tour-review' && overCap) key = 'held-over-cap';
      if (key === 'tour-review' && execute) {
        fs.mkdirSync(toDir, { recursive: true });
        const res = safeWriteReview(path.join(toDir, file), prepareTourMove(data, { fromShowId: fromId, tourId: plan.tourId, at }), { merge: false });
        if (!res || res.wrote === false) {
          // The guard refused or quarantined it (_pending/<tour>/): keep the
          // Broadway file, or the review would be on neither show.
          key = `write-refused:${(res && res.skipped) || 'unknown'}`;
        } else {
          fs.unlinkSync(path.join(reviewTextsDir, fromId, file));
          if (res.autoFlaggedWrongProduction) key = 'moved-but-reflagged';
        }
      }
      counts[key] = (counts[key] || 0) + 1;
      console.log(`  ${key.padEnd(22)} ${fromId}/${file}`);
      if (key === 'tour-review' || key === 'moved-but-reflagged') totalMoved++;
    }
    console.log(`${execute ? 'EXECUTE' : 'DRY-RUN'} ${plan.fromIds.join(',')} -> ${plan.tourId}: ${JSON.stringify(counts)}\n`);
    report.push({ tourId: plan.tourId, fromIds: plan.fromIds, held: Boolean(overCap), counts });
  }
  console.log(`${execute ? 'moved' : 'would move'}: ${totalMoved}`);
  if (auto) {
    const out = path.join(ROOT, 'data', 'audit', 'tour-sweep.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), moved: totalMoved, held: report.filter(r => r.held).map(r => r.tourId), tours: report }, null, 2) + '\n');
  }
}

if (require.main === module) main();
