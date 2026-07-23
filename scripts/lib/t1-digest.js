'use strict';

/**
 * t1-digest.js — pure classification for the daily T1 coverage digest
 * (sprint-plan-t1-retrieval.md S2-T7).
 *
 * Two audiences:
 *   DIGEST  — every open GAP cell + its age + the exact fix command. A burn-down list.
 *   ACTION  — an email only for NEW gaps that crossed 24h, deduped so a still-stuck
 *             gap doesn't re-email every run.
 *
 * DAY-ONE GRACE (the storm guard): the first time this runs it inherits a huge
 * backlog (every pre-existing gap gets firstSeenAt ≈ now). Those are `pre-rollout`:
 * they existed before we started tracking, so they are DIGEST-ONLY forever — never
 * ACTION-emailed. A gap is pre-rollout when its firstSeenAt <= the persisted
 * rolloutAt. Only gaps born AFTER rollout (firstSeenAt > rolloutAt) can escalate.
 */

const GRACE_HOURS = 24;

/**
 * @param {object} cell  { outletId, state, firstSeenAt }
 * @param {object} ctx   { rolloutAt: ISO, nowMs: number, alerted: Set<string>, cellKey: string }
 * @returns {{ include:boolean, action:boolean, ageHours:number, preRollout:boolean }}
 *   include — show in the digest at all (GAP cells only)
 *   action  — fire an ACTION email (new, >24h, not-yet-alerted, not pre-rollout)
 */
function classifyGapForDigest(cell, ctx) {
  if (cell.state !== 'GAP') return { include: false, action: false, ageHours: 0, preRollout: false };
  const firstMs = Date.parse(cell.firstSeenAt);
  const ageHours = Number.isFinite(firstMs) ? (ctx.nowMs - firstMs) / 3600000 : 0;
  // <= rolloutAt (with a tiny epsilon for same-run stamps) → part of the inherited
  // backlog → digest-only forever.
  const rolloutMs = Date.parse(ctx.rolloutAt);
  const preRollout = Number.isFinite(rolloutMs) && Number.isFinite(firstMs) && firstMs <= rolloutMs + 1000;
  const alreadyAlerted = ctx.alerted && ctx.alerted.has(ctx.cellKey);
  const action = !preRollout && ageHours >= GRACE_HOURS && !alreadyAlerted;
  return { include: true, action, ageHours, preRollout };
}

/**
 * Build the digest over a whole ledger. Pure aside from the injected `now`.
 * @param {object} ledger  { shows: { [showId]: { title, market, cells: {...} } } }
 * @param {object} state   { rolloutAt?, alertedCells?: string[] }
 * @param {number} nowMs
 * @returns {{ rolloutAt, digest:Array, actions:Array, preRolloutCount:number }}
 */
function buildDigest(ledger, state, nowMs) {
  const rolloutAt = (state && state.rolloutAt) || new Date(nowMs).toISOString();
  const alerted = new Set((state && state.alertedCells) || []);
  const shows = (ledger && ledger.shows) || {};
  const digest = [];
  const actions = [];
  let preRolloutCount = 0;
  for (const showId of Object.keys(shows).sort()) {
    const s = shows[showId];
    for (const outletId of Object.keys(s.cells || {}).sort()) {
      const cell = { outletId, ...s.cells[outletId] };
      const cellKey = `${showId}::${outletId}`;
      const c = classifyGapForDigest(cell, { rolloutAt, nowMs, alerted, cellKey });
      if (!c.include) continue;
      const row = {
        showId, title: s.title, market: s.market, outletId,
        ageHours: Math.round(c.ageHours), preRollout: c.preRollout,
        fix: `gh workflow run gather-reviews.yml -f shows="${showId}" -f max_tier=3 -f aggregators_only=false`,
      };
      digest.push(row);
      if (c.preRollout) preRolloutCount++;
      if (c.action) actions.push(row);
    }
  }
  return { rolloutAt, digest, actions, preRolloutCount };
}

module.exports = { classifyGapForDigest, buildDigest, GRACE_HOURS };
