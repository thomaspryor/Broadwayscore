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
const { aggregateProblems, legsByAggregate } = require('./lib/tour-aggregate-rules');

const ROOT = path.join(__dirname, '..');

function urlKey(u) {
  return String(u || '').split('#')[0].split('?')[0].replace(/\/+$/, '').toLowerCase();
}

/**
 * @param {{shows: object[], reviews: object[], aggregateId: string, transferLegId: string}} input
 * @returns {{ok: true, dropRows: object[], legIds: string[], transferredTo: string|null, aliases: string[]} | {ok: false, reason: string}}
 */
function planUnlink({ shows, reviews, aggregateId, transferLegId }) {
  const byId = new Map(shows.map((s) => [s.id, s]));
  const agg = byId.get(aggregateId);
  if (!agg) return { ok: false, reason: `no show with id "${aggregateId}"` };
  const legs = legsByAggregate(shows).get(aggregateId) || [];
  if (legs.length === 0) return { ok: false, reason: `"${aggregateId}" has no legs (no show names it in tourParent)` };
  const why = aggregateProblems(agg, legs);
  if (why.length === 0) return { ok: false, reason: `"${aggregateId}" looks like a real tour (legs open close together under one director): refusing to take it apart` };
  const transferLeg = legs.find((l) => l.id === transferLegId);
  if (!transferLeg) return { ok: false, reason: `--transfer-leg "${transferLegId}" is not one of the legs (${legs.map((l) => l.id).join(', ')})` };

  const legKeys = new Set();
  for (const r of reviews) {
    if (legs.some((l) => l.id === r.showId)) legKeys.add(`${r.outletId}|${urlKey(r.url)}`);
  }
  const dropRows = reviews.filter((r) => r.showId === aggregateId);
  // A row with no URL cannot be shown to be a copy: it would match any URL-less leg row of its outlet.
  const orphans = dropRows.filter((r) => !urlKey(r.url) || !legKeys.has(`${r.outletId}|${urlKey(r.url)}`));
  if (orphans.length) {
    return { ok: false, reason: `${orphans.length} aggregate review row(s) have no twin on a leg, dropping them would delete reviews: ${orphans.map((r) => `${r.outletId} ${r.publishDate}`).join(', ')}` };
  }

  const target = agg.transferredTo ? byId.get(agg.transferredTo) : null;
  if (agg.transferredTo && !target) return { ok: false, reason: `aggregate transferredTo "${agg.transferredTo}" is not in shows.json` };
  if (target && target.transferOf && target.transferOf !== aggregateId) return { ok: false, reason: `"${target.id}" transferOf is "${target.transferOf}", not the aggregate: not touching it` };
  if (transferLeg.transferredTo && transferLeg.transferredTo !== agg.transferredTo) return { ok: false, reason: `leg "${transferLeg.id}" already has transferredTo "${transferLeg.transferredTo}"` };

  return {
    ok: true,
    dropRows,
    legIds: legs.map((l) => l.id),
    transferredTo: agg.transferredTo || null,
    aliases: [agg.id, agg.slug].filter((x) => x && x !== transferLeg.id && x !== transferLeg.slug),
  };
}

/** Apply a successful plan to the in-memory rows (shows mutated in place; returns the kept reviews). */
function applyUnlink({ shows, reviews, aggregateId, transferLegId }, plan) {
  const byId = new Map(shows.map((s) => [s.id, s]));
  const agg = byId.get(aggregateId);
  for (const id of plan.legIds) delete byId.get(id).tourParent;
  const leg = byId.get(transferLegId);
  if (plan.transferredTo) {
    leg.transferredTo = plan.transferredTo;
    byId.get(plan.transferredTo).transferOf = leg.id;
    delete agg.transferredTo;
  }
  leg.aliases = [...new Set([...(Array.isArray(leg.aliases) ? leg.aliases : []), ...plan.aliases])];
  return reviews.filter((r) => r.showId !== aggregateId);
}

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

module.exports = { planUnlink, applyUnlink };
