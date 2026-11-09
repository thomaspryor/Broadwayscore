#!/usr/bin/env node
/**
 * Take a false "tour" roll-up apart (BRO-7192): separate productions that a
 * `tourParent` aggregate grouped as one tour go back to standing alone.
 *
 * Run through a pending-fix plan's run-script action, followed by a
 * retire-show action for the aggregate (the aggregate row is provisional and,
 * once this script has dropped its review rows, has none).
 *
 *   node scripts/unlink-tour-aggregate.js --aggregate=<id> --transfer-leg=<leg id>             # dry run
 *   node scripts/unlink-tour-aggregate.js --aggregate=<id> --transfer-leg=<leg id> --apply --expect=N
 *
 * What it does, all or nothing:
 *   - refuses a real tour (tour-aggregate-rules.js finds nothing wrong with it);
 *   - drops the aggregate's review rows from reviews.json. Every one must be a
 *     copy of a row on one of its legs (same outlet, same URL), so no review
 *     leaves the site; a row with no twin refuses the run. `--expect=N` must
 *     equal the number dropped;
 *   - clears `tourParent` on every leg;
 *   - moves the aggregate's `transferredTo` to `--transfer-leg` (the production
 *     that actually became the Broadway show) and re-points the Broadway
 *     show's `transferOf` there;
 *   - adds the aggregate's id and slug to that leg's `aliases`, so the old URL
 *     redirects to a page that still exists (build-slug-redirects.js).
 *
 * Pure planner (planUnlink) + thin IO shell; the planner is what the test runs.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { planUnlink, applyUnlink } = require('./lib/tour-aggregate-unlink');
require('./lib/cli-help').exitOnHelp(module);

const ROOT = path.join(__dirname, '..');

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

function main() {
  const aggregateId = arg('aggregate');
  const transferLegId = arg('transfer-leg');
  const apply = process.argv.includes('--apply');
  const expect = arg('expect');
  if (!aggregateId || !transferLegId) {
    console.error('usage: unlink-tour-aggregate.js --aggregate=<id> --transfer-leg=<leg id> [--apply --expect=N]');
    process.exit(2);
  }
  const { loadShows, saveShows } = require('./lib/shows-write-guard');
  const showsData = loadShows();
  const reviewsPath = path.join(ROOT, 'data', 'reviews.json');
  const reviewsData = JSON.parse(fs.readFileSync(reviewsPath, 'utf8'));
  const input = { shows: showsData.shows, reviews: reviewsData.reviews, aggregateId, transferLegId };
  const plan = planUnlink(input);
  if (!plan.ok) { console.error(`REFUSED: ${plan.reason}`); process.exit(1); }
  console.log(`${aggregateId}: ${plan.dropRows.length} duplicate review row(s) to drop, legs ${plan.legIds.join(', ')}, transfer ${plan.transferredTo || '(none)'} <- ${transferLegId}`);
  if (!apply) { console.log('dry run: pass --apply --expect=N to write'); return; }
  if (String(plan.dropRows.length) !== String(expect)) {
    console.error(`REFUSED: --expect=${expect} but ${plan.dropRows.length} rows would drop`);
    process.exit(1);
  }
  reviewsData.reviews = applyUnlink(input, plan);
  if (reviewsData._meta && reviewsData._meta.stats) reviewsData._meta.stats.totalReviews = reviewsData.reviews.length;
  // reviews.json first, via temp + rename, so a failed write changes nothing; the shows.json
  // save is then the last step.
  const tmp = `${reviewsPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(reviewsData, null, 2) + '\n');
  fs.renameSync(tmp, reviewsPath);
  saveShows(showsData);
  console.log(`done: dropped ${plan.dropRows.length} rows, unlinked ${plan.legIds.length} legs`);
}

if (require.main === module) main();

