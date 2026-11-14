'use strict';

/**
 * Pure planner for scripts/unlink-tour-aggregate.js (BRO-7192): which rows to drop and how
 * to relink when a false tourParent roll-up is taken apart. No IO.
 */

const { aggregateProblems, legsByAggregate } = require('./tour-aggregate-rules');

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

module.exports = { planUnlink, applyUnlink };
