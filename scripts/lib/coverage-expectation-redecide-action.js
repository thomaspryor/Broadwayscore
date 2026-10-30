'use strict';

/**
 * coverage-expectation-redecide: refresh a decayed `coverageExpectation: 'reviews'`
 * claim in data/outlet-registry.json for execute-approved-fix.js (BRO-6610).
 *
 *   { type: 'coverage-expectation-redecide', outletId, reason }
 *
 * "Quality: coverageExpectation drift" fires every 14 days (DECAY_DAYS) for each
 * outlet whose "this outlet reviews Broadway" claim is older than the window.
 * The re-decision was a hand edit of the registry that cloud sessions cannot
 * make. The action re-measures at execute time (evaluateCoverageExpectationDrift,
 * the same predicate the health check uses) and only then stamps
 * coverageExpectationDecidedAt with today and appends the measured rate to
 * coverageEvidence. It never changes the claim itself:
 *   - status active: ok no-op (a re-dispatched plan or a racing session)
 *   - status decayed + claim 'reviews': refresh
 *   - contradicted, no-evidence, or a "no review expected" claim: refuse, those
 *     need a human to re-decide the claim, not a date bump
 *
 * Pure: mutates the parsed registry, returns {ok, msg} or {ok:false, reason}.
 */

const { evaluateCoverageExpectationDrift } = require('../audit-standing-coverage');
const { MIN_PLAUSIBLE_SHOWS } = require('./live-show-ids');

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const MIN_PLAUSIBLE_REVIEWS = 1000;

function applyCoverageExpectationRedecide(registry, action, { shows, reviews, nowMs = Date.now() }) {
  const { outletId, reason } = action || {};
  const tag = `coverage-expectation-redecide ${outletId}`;
  if (!outletId || !ID_RE.test(outletId)) return { ok: false, reason: 'coverage-expectation-redecide: outletId missing or malformed' };
  if (!reason || String(reason).trim().length < 10) return { ok: false, reason: `${tag}: reason (>=10 chars) required` };
  const outlets = registry && registry.outlets;
  if (!outlets || !Object.prototype.hasOwnProperty.call(outlets, outletId)) return { ok: false, reason: `${tag}: not in outlet-registry.json` };
  // A stub or truncated input reads as "no evidence"; refuse rather than stamp on it.
  if (!Array.isArray(shows) || shows.length < MIN_PLAUSIBLE_SHOWS) return { ok: false, reason: `${tag}: shows.json has ${shows ? shows.length : 0} rows (< ${MIN_PLAUSIBLE_SHOWS}), refusing on a stub` };
  if (!Array.isArray(reviews) || reviews.length < MIN_PLAUSIBLE_REVIEWS) return { ok: false, reason: `${tag}: reviews.json has ${reviews ? reviews.length : 0} rows (< ${MIN_PLAUSIBLE_REVIEWS}), refusing on a stub` };

  const entry = outlets[outletId];
  if (entry.coverageExpectation !== 'reviews' || entry.reviewsTheater === false) {
    return { ok: false, reason: `${tag}: only a coverageExpectation "reviews" claim can be refreshed by plan (a "no review expected" claim needs a human re-decision)` };
  }
  const row = evaluateCoverageExpectationDrift(shows, reviews, outlets, nowMs).rows.find((r) => r.outletId === outletId);
  if (!row) return { ok: false, reason: `${tag}: no coverageExpectation claim found` };
  if (row.status === 'active') return { ok: true, changed: false, msg: `${outletId}: coverageExpectation already active (decided ${row.decidedAt})` };
  if (row.status !== 'decayed') return { ok: false, reason: `${tag}: status is ${row.status}, not decayed; needs a human re-decision` };

  const day = new Date(nowMs).toISOString().slice(0, 10);
  const pct = (row.overall * 100).toFixed(1);
  const note = `Re-probed ${day} after the ${Math.round(row.ageDays)}-day-old decision decayed (${String(reason).trim().slice(0, 120)}): measured ${pct}% overall 3-season Broadway coverage; claim unchanged, decidedAt refreshed.`;
  entry.coverageExpectationDecidedAt = day;
  entry.coverageEvidence = entry.coverageEvidence ? `${entry.coverageEvidence} ${note}` : note;
  registry._meta = { ...(registry._meta || {}), lastUpdated: new Date(nowMs).toISOString(), lastChange: `BRO-6610: coverageExpectation re-decided ${outletId}` };
  return { ok: true, changed: true, msg: `${outletId}: coverageExpectationDecidedAt ${row.decidedAt} -> ${day} (measured ${pct}%)` };
}

module.exports = { applyCoverageExpectationRedecide };
