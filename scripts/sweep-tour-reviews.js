#!/usr/bin/env node
/**
 * Move national-tour reviews from Broadway show folders to their tour entry (BRO-4211).
 *
 * A tour review for a show that has a tour entry lands on the Broadway show,
 * flagged wrongProduction and excluded from its score. This sweep moves each
 * one to the tour, under the rules in scripts/lib/tour-backfill.js
 * (classifyTourBackfill / prepareTourMove / planTourSweep).
 *
 * Run it when a tour entry is added to shows.json. It is not scheduled: every
 * tour so far has closed, and an unattended mover needs a live tour to justify
 * it (second-opinion review, 2026-09-28).
 *
 * Usage:
 *   node scripts/sweep-tour-reviews.js --all                  # dry-run every tour
 *   node scripts/sweep-tour-reviews.js --tour=<tour id>       # dry-run one tour
 *   ... add --execute to move. --reviewTextsDir=<dir> overrides data/review-texts.
 *
 * Each moved file records its origin (routedFromShowId, routedAt, routedReason,
 * routedPriorVerdicts), which is the undo record; there is no separate manifest.
 */

const fs = require('fs');
const path = require('path');
const { safeWriteReview } = require('./lib/review-write-guard');
const { prepareTourMove, planTourSweep, decideTourSweep } = require('./lib/tour-backfill');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `sweep-tour-reviews.js — move national-tour reviews from Broadway show folders to their tour entry.

Usage:
  node scripts/sweep-tour-reviews.js --all | --tour=<tour id> [--execute] [--reviewTextsDir=<dir>]
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
  const execute = process.argv.includes('--execute');
  const all = process.argv.includes('--all');
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
  for (const plan of plans) {
    const toDir = path.join(reviewTextsDir, plan.tourId);
    const counts = {};
    const at = new Date().toISOString();
    for (const { fromId, file, data, key: decided } of decideTourSweep(plan, listFiles)) {
      let key = decided;
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
  }
  console.log(`${execute ? 'moved' : 'would move'}: ${totalMoved}`);
}

if (require.main === module) main();
