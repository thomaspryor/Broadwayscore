/**
 * Who excluded a round-up-listed review, and should it be re-checked (BRO-4971).
 *
 * audit-show-review-gap.js collects `flaggedMisses`: reviews a reference
 * round-up (Best of Theatre, WestEndTheatre, theatre.reviews, LBO, the NYC
 * aggregators) lists for the show, where we hold a file but the rebuild
 * excludes it. That list was report-only, so an automated false-positive
 * exclusion sat there forever. A backtest found 5 of 16 London rows were
 * false positives: a CV wrongProduction, a CV-promoted isNonReview 'preview',
 * a stale same-URL sibling slot, a heuristic awards_coverage, a showNotMentioned.
 *
 * A round-up listing the review is independent evidence against an AUTOMATED
 * verdict, but not against a human one. So each row is split:
 *   humanExcluded     - some excluded file for the URL carries a human assertion
 *                       (never second-guessed; no re-verify)
 *   automatedExcluded - every excluded file was excluded by a detector; `basis`
 *                       names which (explainExclusion reasons)
 * and an automated row listed by a CURRENT-run round-up (not a prior-production
 * citation) gets `reverify: true`.
 *
 * Reporting only: nothing here changes what the rebuild includes.
 * Pure: no fs, no process.
 */

'use strict';

const { hasHumanAssertedFlag } = require('./contradicted-flag-basis');
const { isHumanRejecter } = require('./stale-automated-text-verdict');
const { isPriorProductionCitation } = require('./prior-production-citations');

// Breadcrumb keys a person (or an operator-run triage) writes when asserting an
// exclusion, e.g. wrongProductionManual / isNonReviewManual. `...ManualClear`
// is the opposite (a human UN-excluded it) and is not an exclusion assertion.
const MANUAL_SUFFIX = /Manual$/;

/**
 * True when the file's exclusion carries a human assertion. Superset of
 * contradicted-flag-basis.js hasHumanAssertedFlag: also _locked, a manual-/
 * human-/audit- rejectedBy, isNotReview, manualContentTier, and *Manual flags.
 */
function hasHumanExclusionAssertion(d) {
  if (!d || typeof d !== 'object') return false;
  if (hasHumanAssertedFlag(d)) return true;
  if (d._locked) return true;
  if (isHumanRejecter(d.rejectedBy)) return true;
  if (d.isNotReview === true) return true;
  if (d.manualContentTier != null) return true;
  if (typeof d.nonReviewMethod === 'string' && /^(manual|human)/i.test(d.nonReviewMethod)) return true;
  return Object.keys(d).some(k => MANUAL_SUFFIX.test(k) && d[k] === true);
}

// Raw detector fields, read when the canonical reason is unavailable. Some
// rebuild-only guards (showNotMentioned: text scan + LLM CV) are not mirrored
// by review-guards explainExclusion, which then reports nothing for the file.
const RAW_DETECTOR_FIELDS = ['wrongProduction', 'wrongShow', 'isNonReview', 'nonReviewFlag',
  'showNotMentioned', 'rejectionReason', 'isRoundupArticle', 'duplicateOf'];

function rawDetectorBasis(d) {
  const hit = RAW_DETECTOR_FIELDS.find(k => d[k] != null && d[k] !== false && d[k] !== '');
  return hit || null;
}

/**
 * Classify one flaggedMiss from its excluded dir files.
 * @param {object[]} files - the excluded dir files for the listed URL
 * @param {(d: object) => (string|null)} [explain] - exclusion reason for a file
 *   (review-guards explainExclusion bound to the show); null/throw falls back
 *   to the raw detector field, then 'unknown'
 * @returns {{ exclusion: 'humanExcluded'|'automatedExcluded', basis: string[] }}
 */
function classifyFlaggedMiss(files, explain) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  const human = list.some(hasHumanExclusionAssertion);
  const basis = [];
  for (const d of list) {
    let reason = null;
    try { reason = explain ? explain(d) : null; } catch { reason = null; }
    const r = reason || rawDetectorBasis(d) || 'unknown';
    if (!basis.includes(r)) basis.push(r);
  }
  return { exclusion: human ? 'humanExcluded' : 'automatedExcluded', basis };
}

/** Re-check an automated exclusion only when a current-run round-up lists it. */
function shouldReverify(m) {
  return !!m && m.exclusion === 'automatedExcluded' && !isPriorProductionCitation(m);
}

/** Count of flaggedMisses marked reverify (automated, current-run listed). */
function countAutomatedExcludedListed(flaggedMisses) {
  return Array.isArray(flaggedMisses) ? flaggedMisses.filter(m => m && m.reverify === true).length : 0;
}

module.exports = {
  hasHumanExclusionAssertion,
  rawDetectorBasis,
  classifyFlaggedMiss,
  shouldReverify,
  countAutomatedExcludedListed,
};
