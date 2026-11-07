'use strict';

/**
 * outlet-registry-flag: flip an outlet's `standingCoverage` flag in
 * data/outlet-registry.json for execute-approved-fix.js (BRO-6122).
 *
 *   { type: 'outlet-registry-flag', outletId, flag: 'standingCoverage', value: true|false, reason }
 *
 * The flag is derived from measured Broadway coverage (card #627), so a plan
 * never asserts it: the action refuses unless scripts/audit-standing-coverage.js
 * (evaluateStandingCoverage, run on the current shows/reviews) lists the outlet
 * in `promote` (value true) or `demote` (value false). Already at the target
 * value is an ok no-op, so a re-dispatched plan or a racing session does not
 * fail. Promote also writes standingMarkets ['broadway'] (every flagged outlet
 * carries it; tests/unit/standing-coverage-registry.test.mjs pins it); demote
 * removes both fields.
 *
 * Pure: mutates the parsed registry, returns {ok, msg} or {ok:false, reason}.
 */

const { evaluateStandingCoverage } = require('../audit-standing-coverage');
const { MIN_PLAUSIBLE_SHOWS } = require('./live-show-ids');

const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const MIN_PLAUSIBLE_REVIEWS = 1000;
const ALLOWED_FLAGS = new Set(['standingCoverage']);

function applyOutletRegistryFlag(registry, action, { shows, reviews, nowMs = Date.now() }) {
  const { outletId, flag, value, reason } = action || {};
  const tag = `outlet-registry-flag ${outletId}`;
  if (!ALLOWED_FLAGS.has(flag)) return { ok: false, reason: `${tag}: unsupported flag ${flag}` };
  if (!outletId || !ID_RE.test(outletId)) return { ok: false, reason: 'outlet-registry-flag: outletId missing or malformed' };
  if (typeof value !== 'boolean') return { ok: false, reason: `${tag}: value must be true or false` };
  if (!reason || String(reason).trim().length < 10) return { ok: false, reason: `${tag}: reason (>=10 chars) required` };
  const outlets = registry && registry.outlets;
  if (!outlets || !Object.prototype.hasOwnProperty.call(outlets, outletId)) return { ok: false, reason: `${tag}: not in outlet-registry.json` };
  // A stub or truncated input reads as "no evidence" and would drive a wrong demote.
  if (!Array.isArray(shows) || shows.length < MIN_PLAUSIBLE_SHOWS) return { ok: false, reason: `${tag}: shows.json has ${shows ? shows.length : 0} rows (< ${MIN_PLAUSIBLE_SHOWS}), refusing on a stub` };
  if (!Array.isArray(reviews) || reviews.length < MIN_PLAUSIBLE_REVIEWS) return { ok: false, reason: `${tag}: reviews.json has ${reviews ? reviews.length : 0} rows (< ${MIN_PLAUSIBLE_REVIEWS}), refusing on a stub` };

  const entry = outlets[outletId];
  // Strict compare: a truthy non-boolean ("false") is malformed state, not "already set".
  const current = entry.standingCoverage === true;
  if (entry.standingCoverage !== undefined && typeof entry.standingCoverage !== 'boolean') return { ok: false, reason: `${tag}: existing standingCoverage ${JSON.stringify(entry.standingCoverage)} is not a boolean, refusing` };
  if (current === value) {
    // Already flagged but missing standingMarkets (standing-outlets.js would default it): repair, no audit needed.
    if (value && !Array.isArray(entry.standingMarkets)) {
      entry.standingMarkets = ['broadway'];
      return { ok: true, changed: true, msg: `${outletId}: standingCoverage already true; added missing standingMarkets` };
    }
    return { ok: true, changed: false, msg: `${outletId}: standingCoverage already ${value}` };
  }

  const audit = evaluateStandingCoverage(shows, reviews, outlets, nowMs);
  const list = value ? audit.promote : audit.demote;
  if (!list.includes(outletId)) {
    return { ok: false, reason: `${tag}: audit-standing-coverage does not list it for ${value ? 'promote' : 'demote'} (promote: ${audit.promote.join(', ') || 'none'}; demote: ${audit.demote.join(', ') || 'none'})` };
  }

  if (value) {
    entry.standingCoverage = true;
    entry.standingMarkets = ['broadway'];
  } else {
    delete entry.standingCoverage;
    delete entry.standingMarkets;
  }
  const at = new Date(nowMs).toISOString();
  registry._meta = { ...(registry._meta || {}), lastUpdated: at, lastChange: `BRO-6122: standingCoverage ${value ? 'promote' : 'demote'} ${outletId} (${String(reason).trim().slice(0, 120)})` };
  return { ok: true, changed: true, msg: `${outletId}: standingCoverage ${!value} -> ${value}` };
}

module.exports = { applyOutletRegistryFlag, MIN_PLAUSIBLE_REVIEWS };
