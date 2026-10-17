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
 * A reviewed backlog gets through with an unexpired entry in
 * data/tour-sweep-approvals.json (sweepLimits in scripts/lib/tour-backfill.js).
 *
 * Before moving, an integrity pass (decideTourIntegrity) flags tour-stop
 * reviews counting on a Broadway show and UK-production reviews counting on a
 * tour; more than --max-flags (10) in one run flags nothing.
 *
 * Each moved file records its origin (routedFromShowId, routedAt, routedReason,
 * routedPriorVerdicts), which is the undo record; there is no separate manifest.
 */

const fs = require('fs');
const path = require('path');
const { safeWriteReview } = require('./lib/review-write-guard');
const { prepareTourMove, planTourSweep, decideTourSweep, sweepHoldReason, loadSweepContext, sweepLimits, decideTourIntegrity, applyIntegrityFlag, clearStaleScoringFailure } = require('./lib/tour-backfill');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `sweep-tour-reviews.js — move national-tour reviews from Broadway show folders to their tour entry.

Usage:
  node scripts/sweep-tour-reviews.js --all | --tour=<tour id> [--execute] [--reviewTextsDir=<dir>]
  node scripts/sweep-tour-reviews.js --auto [--max-moves=20] [--max-flags=10]   scheduled mop-up with hard stops
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
  if (auto && process.env.TOUR_SWEEP === 'off') {
    console.log('TOUR_SWEEP=off — skipping');
    // Still report, so the digest can tell "switched off" from "stopped running".
    const out = path.join(ROOT, 'data', 'audit', 'tour-sweep.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), mode: 'off', moved: 0, held: [], tours: [] }, null, 2) + '\n');
    return;
  }
  const execute = (process.argv.includes('--execute') || auto) && process.env.TOUR_SWEEP !== 'report';
  const all = process.argv.includes('--all') || auto;
  const maxMoves = Number(flag('max-moves')) || 20;
  const only = flag('tour');
  if (!all && !only) { console.error(USAGE); process.exit(2); }
  const reviewTextsDir = flag('reviewTextsDir') || path.join(ROOT, 'data', 'review-texts');
  const raw = readJson(path.join(ROOT, 'data', 'shows.json'));
  const shows = Array.isArray(raw) ? raw : (raw && raw.shows) || [];
  // Reviewed backlogs allowed past the hard stop (BRO-4656), see sweepLimits.
  const approvals = readJson(path.join(ROOT, 'data', 'tour-sweep-approvals.json'));
  const plans = planTourSweep(shows, loadSweepContext(ROOT)).filter(p => all || p.tourId === only);
  if (only && plans.length === 0) {
    console.error(`${only} must exist in shows.json with category 'tour' and, if it has a tourOf, one that exists`); process.exit(2);
  }
  // A standalone tour (no tourOf, BRO-4931) has no production whose folders
  // could hold its reviews: there is nothing to move.
  if (only && plans.every(p => p.fromIds.length === 0)) {
    console.log(`${only} has no parent production (standalone tour): nothing to sweep`);
    process.exit(0);
  }

  const listFiles = (showId) => {
    const dir = path.join(reviewTextsDir, showId);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(n => n.endsWith('.json')).sort()
      .map(file => ({ file, data: readJson(path.join(dir, file)) }));
  };

  // Integrity pass first (BRO-4656): flag tour-stop reviews counting on a
  // Broadway show (the move pass below then re-homes them) and UK-production
  // reviews counting on a North American tour. More than maxFlags in one run
  // means a rule broke: flag nothing, warn.
  const maxFlags = Number(flag('max-flags')) || 10;
  // Two tours of one title (Beetlejuice 2022 and 2026) share Broadway folders:
  // one flag per file.
  const seen = new Set();
  const flags = plans.flatMap(plan => decideTourIntegrity(plan, listFiles))
    .filter(r => !seen.has(`${r.showId}/${r.file}`) && seen.add(`${r.showId}/${r.file}`));
  const flagHeld = flags.length > maxFlags;
  if (flagHeld) console.log(`::warning::tour integrity held: ${flags.length} flags > cap ${maxFlags}. Nothing flagged; review with node scripts/sweep-tour-reviews.js --all`);
  let flagged = 0;
  for (const row of flags) {
    let key = flagHeld ? 'flag-held' : `flag-${row.kind}`;
    if (execute && !flagHeld) {
      const file = path.join(reviewTextsDir, row.showId, row.file);
      const res = safeWriteReview(file, applyIntegrityFlag(readJson(file), row), { merge: false });
      if (!res || res.wrote === false || res.lockedSkipped) key = `flag-refused:${(res && res.skipped) || (res && res.lockedSkipped ? 'locked' : 'unknown')}`;
      else flagged++;
    }
    console.log(`  ${key.padEnd(22)} ${row.showId}/${row.file}  ${row.reason}`);
  }

  let totalMoved = 0;
  const report = [];
  for (const plan of plans) {
    if (plan.fromIds.length === 0) continue; // standalone tour
    const toDir = path.join(reviewTextsDir, plan.tourId);
    const counts = {};
    const at = new Date().toISOString();
    const rows = decideTourSweep(plan, listFiles);
    const pending = rows.filter(r => r.key === 'tour-review');
    const limits = sweepLimits(approvals, plan.tourId, { maxMoves });
    if (limits.approvedBy && pending.length) console.log(`${plan.tourId}: reviewed backlog (${limits.approvedBy}), up to ${limits.maxMoves} moves`);
    const holdReason = auto ? sweepHoldReason(pending, plan.fromIds, id => listFiles(id).length, limits) : null;
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

  // Files moved before prepareTourMove dropped the scorer's give-up state
  // still carry it, and the scorer skips them for good. Set it aside.
  let repaired = 0;
  for (const tourId of new Set(plans.map(p => p.tourId))) {
    for (const { file, data } of listFiles(tourId)) {
      const fixed = clearStaleScoringFailure(data);
      if (!fixed) continue;
      if (execute) {
        // force: these fields are write-protected (a rebase must not drop them);
        // clearing them here is the point, and the guard logs the override.
        const res = safeWriteReview(path.join(reviewTextsDir, tourId, file), fixed, { merge: false, force: true });
        if (!res || res.wrote === false) { console.log(`  repair-refused         ${tourId}/${file}`); continue; }
        repaired++;
      }
      console.log(`  ${execute ? 'scoring-unblocked' : 'would-unblock'}      ${tourId}/${file}`);
    }
  }
  if (auto) {
    const out = path.join(ROOT, 'data', 'audit', 'tour-sweep.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), moved: totalMoved, held: report.filter(r => r.held).map(r => r.tourId),
      repaired, integrity: { flagged, held: flagHeld, rows: flags.map(r => ({ file: `${r.showId}/${r.file}`, kind: r.kind })) }, tours: report }, null, 2) + '\n');
  }
}

if (require.main === module) main();
