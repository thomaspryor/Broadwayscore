/**
 * BRO-6336: what the verified auto-apply pass does with one pending entry, decided from page evidence only.
 * An entry whose figures (capitalization, weeklyRunningCost) are all confirmed on a fetched trusted page applies,
 * whatever its research confidence. Everything else is left pending (a cited page could not be fetched yet),
 * moved to the archive with the reason (the page loaded and does not state the figure, nothing citable to check,
 * or the fetch failed on every attempt), or held for a person (the daily health check files a worker card for it).
 */
'use strict';

const { nextVerifyAttempt, SOURCE_VERIFY_MAX_ATTEMPTS } = require('./commercial-source-verify');

const FIGURE_FIELDS = ['capitalization', 'weeklyRunningCost'];
const UNVERIFIED_REASON = 'unverified-figure';
const OUT_OF_SCOPE_REASON = 'out-of-commercial-scope';

/**
 * @param {object} entry pending entry
 * @param {object} evidence what createSourceVerifier returned for it ({capitalization:{...}, capped?, fetchFailed?})
 * @returns {{action:'apply'|'defer'|'retry'|'reject', attempts?:number, reason?:string}}
 */
function verifiedOutcome(entry, evidence, max = SOURCE_VERIFY_MAX_ATTEMPTS) {
  const figures = FIGURE_FIELDS.filter((f) => entry && entry[f] != null);
  // Nothing to verify (recouped flag, closing date, recoupment percentage): the verifier has no say, so the
  // normal guards decide, exactly as the weekly high-confidence pass did before.
  if (!figures.length) return { action: 'apply' };
  if (evidence && evidence.capped) return { action: 'defer' };
  const missing = figures.filter((f) => !(evidence && evidence[f]));
  if (!missing.length) return { action: 'apply' };
  if (evidence && evidence.fetchFailed) {
    const { attempts, leavePending } = nextVerifyAttempt(entry, max);
    if (leavePending) return { action: 'retry', attempts };
    return { action: 'reject', attempts, reason: `a cited page could not be fetched on ${attempts} runs (${missing.join(', ')} unchecked)` };
  }
  return { action: 'reject', reason: `no trusted cited page states the ${missing.join(' / ')} figure` };
}

module.exports = { verifiedOutcome, UNVERIFIED_REASON, OUT_OF_SCOPE_REASON, FIGURE_FIELDS };
