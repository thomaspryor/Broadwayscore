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

// States that belong in the burn-down list. GAP is the actionable one;
// CIRCUIT_OPEN (B2) is a GAP the per-outlet breaker has paused dispatch on — it
// MUST still be listed, because "we stopped trying" is precisely the thing the
// owner needs to see. Including it here was a ship-check finding: the breaker
// originally converted GAP→CIRCUIT_OPEN and the cell then vanished from BOTH the
// digest and the scoreboard, recreating the silent-gap failure the whole v2 plan
// exists to kill (the code even claimed the opposite in a comment).
const DIGEST_STATES = new Set(['GAP', 'CIRCUIT_OPEN']);

/**
 * @param {object} cell  { outletId, state, firstSeenAt }
 * @param {object} ctx   { rolloutAt: ISO, nowMs: number, alerted: Set<string>, cellKey: string }
 * @returns {{ include:boolean, action:boolean, ageHours:number, preRollout:boolean, actionable:boolean }}
 *   include    — show in the digest at all (GAP + CIRCUIT_OPEN)
 *   action     — fire an ACTION email (new, >24h, not-yet-alerted, not pre-rollout,
 *                and ACTIONABLE — a circuit-open cell is reported, never paged,
 *                because the owner can't act on it and the ACTION email exists
 *                to trigger a dispatch that would be a no-op)
 *   actionable — false for CIRCUIT_OPEN, so callers can label the row
 */
function classifyGapForDigest(cell, ctx) {
  if (!DIGEST_STATES.has(cell.state)) {
    return { include: false, action: false, ageHours: 0, preRollout: false, actionable: false };
  }
  const actionable = cell.state === 'GAP';
  const firstMs = Date.parse(cell.firstSeenAt);
  const ageHours = Number.isFinite(firstMs) ? (ctx.nowMs - firstMs) / 3600000 : 0;
  // <= rolloutAt (with a tiny epsilon for same-run stamps) → part of the inherited
  // backlog → digest-only forever.
  const rolloutMs = Date.parse(ctx.rolloutAt);
  const preRollout = Number.isFinite(rolloutMs) && Number.isFinite(firstMs) && firstMs <= rolloutMs + 1000;
  const alreadyAlerted = ctx.alerted && ctx.alerted.has(ctx.cellKey);
  const action = actionable && !preRollout && ageHours >= GRACE_HOURS && !alreadyAlerted;
  return { include: true, action, ageHours, preRollout, actionable };
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
        state: cell.state,
        actionable: c.actionable,
        ageHours: Math.round(c.ageHours), preRollout: c.preRollout,
        // A circuit-open cell's "fix" is not another gather — that's the spend the
        // breaker exists to stop. Point at the breaker state instead.
        fix: c.actionable
          ? `gh workflow run gather-reviews.yml -f shows="${showId}" -f max_tier=3 -f aggregators_only=false`
          : `dispatch PAUSED by the outlet circuit breaker (data/audit/t1-outlet-breaker.json → ${outletId}); auto-probes on its own schedule`,
      };
      digest.push(row);
      if (c.preRollout) preRolloutCount++;
      if (c.action) actions.push(row);
    }
  }
  return { rolloutAt, digest, actions, preRolloutCount };
}

module.exports = { classifyGapForDigest, buildDigest, GRACE_HOURS };
