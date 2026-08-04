'use strict';

/**
 * aggregator-url-latent.js — the two predicates behind the "latent aggregator URL"
 * failure class, in ONE place so the validator and the ratchet cannot drift apart.
 *
 * WHY THIS EXISTS (task #1002, 2026-08-04 main-red incident):
 * `validate-review-texts.js` has a zero-tolerance check: a review whose `url` is on
 * an aggregator domain but whose `outletId` is a real outlet is a data defect — the
 * stored URL points at a listing page, not the article. One such file (artsdesk--unknown
 * in witness-for-the-prosecution-west-end-2022) reddened the trunk.
 *
 * The subtlety is HOW it got there. That file had been carrying the defect for months,
 * invisible, because the validator skips every review that is excluded from rebuild
 * (wrongProduction, duplicateOf, ...). Task #1017's sweep auto-cleared its
 * wrongProduction flag; the file was promoted into the validated population and the
 * pre-existing defect became a trunk failure — with no human push involved.
 *
 * So the failure class is: **an auto-clear can promote a structurally-invalid record
 * into the validated population at any time.** A corpus scan at the time of the fix
 * found 10 more such files sitting behind exclusion flags — 10 unexploded copies of
 * the same incident, each one auto-clear away from reddening main.
 *
 * `audit-aggregator-url-latent.js` ratchets that latent population so it cannot grow.
 * That guard is only as good as its agreement with the validator about which files are
 * excluded — a copied-and-pasted predicate that drifts is worse than no guard, because
 * it reports a clean number while the real population grows (see
 * memory/feedback_includability_predicates_must_be_canonical.md: a "must match X"
 * comment IS the bug). Hence: both callers require these functions. There is no second
 * copy to drift.
 */

const { AGGREGATOR_DOMAINS, AGGREGATOR_OUTLET_IDS } = require('./aggregator-domains');

if (!AGGREGATOR_DOMAINS || AGGREGATOR_DOMAINS.size === 0 || !AGGREGATOR_OUTLET_IDS || AGGREGATOR_OUTLET_IDS.size === 0) {
  throw new Error('aggregator-url-latent: AGGREGATOR_DOMAINS/AGGREGATOR_OUTLET_IDS failed to load from aggregator-domains.js');
}

/**
 * Flags that take a review OUT of the validated population.
 *
 * Canonical for validate-review-texts.js. duplicateTextOf is a fingerprint-based dedup
 * respected by rebuild-all-reviews.js and audit-review-duplicates.js — the validator
 * must honour it or it errors on legitimate duplicate-text flags (e.g. a Variety review
 * filed under two critic names after criticEnrichedFrom: html-override:jsonld-person
 * updates criticName post-ingest). rejectionReason / suspectedMisattribution files are
 * exclusion tombstones: they cannot double-count, so sharing outlet+critic with their
 * canonical sibling is not a duplicate (merge-review-fields.js deliberately leaves them
 * in place rather than folding their flags into the live file).
 */
const VALIDATOR_EXCLUSION_FLAGS = Object.freeze([
  'duplicateOf',
  'duplicateTextOf',
  'wrongProduction',
  'wrongShow',
  'wrongUrl',
  'wrongAttribution',
  'isRoundupArticle',
  'rejectionReason',
  'suspectedMisattribution',
]);

/**
 * True when validate-review-texts.js skips this review entirely.
 * @param {object} data - parsed review JSON
 * @returns {boolean}
 */
function isSkippedByValidator(data) {
  if (!data || typeof data !== 'object') return false;
  return VALIDATOR_EXCLUSION_FLAGS.some((flag) => Boolean(data[flag]));
}

/**
 * True when the review's URL is an aggregator listing page while its outletId claims a
 * real outlet. Mirrors the aggregator_url_mismatch check in validate-review-texts.js.
 *
 * Fails CLOSED on a malformed URL: an unparseable URL is not a mismatch we can prove,
 * and other validator checks already cover invalid URLs. Never throws.
 *
 * @param {object} data - parsed review JSON
 * @returns {boolean}
 */
function hasAggregatorUrlMismatch(data) {
  if (!data || typeof data !== 'object' || !data.url) return false;
  let hostname;
  try {
    hostname = new URL(data.url).hostname.replace(/^www\./, '');
  } catch {
    return false;
  }
  const outletId = data.outletId || data.outlet || '';
  return AGGREGATOR_DOMAINS.has(hostname) && !AGGREGATOR_OUTLET_IDS.has(outletId);
}

/**
 * Bucket a review for the ratchet.
 *
 *   'live'   — carries the defect AND is in the validated population.
 *              validate-review-texts.js --gate already fails the trunk on this; the
 *              ratchet reports it so a scan is a complete picture, not half of one.
 *   'latent' — carries the defect but is excluded. Invisible to the gate today,
 *              one auto-clear away from becoming 'live'. This is what we ratchet.
 *   'clean'  — no defect.
 *
 * @param {object} data - parsed review JSON
 * @returns {'live'|'latent'|'clean'}
 */
function classifyReview(data) {
  if (!hasAggregatorUrlMismatch(data)) return 'clean';
  return isSkippedByValidator(data) ? 'latent' : 'live';
}

/**
 * Decide whether the observed latent count is acceptable against its pin.
 *
 * Growth fails. Shrinkage does NOT fail: review-texts is a separate repo that bots
 * mutate every ~2min, and a gate that fires when the number IMPROVES would redden the
 * trunk for unrelated pushes — the exact pathology that forced validate-review-texts.js
 * onto a --gate floor in the first place. Shrinkage returns a ratchet hint instead, so
 * the pin gets tightened deliberately rather than by a flapping bot commit.
 *
 * @param {number} observed - latent files found by the scan
 * @param {number} pinned - ceiling from scripts/.aggregator-url-latent.json
 * @returns {{ok: boolean, reason: string, ratchetTo: number|null}}
 */
function evaluateLatentPopulation(observed, pinned) {
  if (!Number.isInteger(observed) || observed < 0) {
    return { ok: false, reason: `observed count is not a non-negative integer: ${observed}`, ratchetTo: null };
  }
  if (!Number.isInteger(pinned) || pinned < 0) {
    return { ok: false, reason: `pinned ceiling is not a non-negative integer: ${pinned}`, ratchetTo: null };
  }
  if (observed > pinned) {
    return {
      ok: false,
      reason: `latent aggregator-URL population grew: ${observed} > ceiling ${pinned}. `
        + 'A new review was written with an aggregator listing URL under a real outletId. '
        + 'Fix the producer and the file — do NOT raise the ceiling to go green.',
      ratchetTo: null,
    };
  }
  if (observed < pinned) {
    return {
      ok: true,
      reason: `latent population shrank to ${observed} (ceiling ${pinned}) — tighten the pin.`,
      ratchetTo: observed,
    };
  }
  return { ok: true, reason: `latent population steady at ${observed} (ceiling ${pinned}).`, ratchetTo: null };
}

module.exports = {
  VALIDATOR_EXCLUSION_FLAGS,
  isSkippedByValidator,
  hasAggregatorUrlMismatch,
  classifyReview,
  evaluateLatentPopulation,
};
