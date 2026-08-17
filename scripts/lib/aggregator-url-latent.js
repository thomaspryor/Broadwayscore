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

const { AGGREGATOR_DOMAINS, AGGREGATOR_OUTLET_IDS, hasPreservableAggregatorScore } = require('./aggregator-domains');
const { normalizeOutlet } = require('./review-normalization');

if (!AGGREGATOR_DOMAINS || AGGREGATOR_DOMAINS.size === 0 || !AGGREGATOR_OUTLET_IDS || AGGREGATOR_OUTLET_IDS.size === 0) {
  throw new Error('aggregator-url-latent: AGGREGATOR_DOMAINS/AGGREGATOR_OUTLET_IDS failed to load from aggregator-domains.js');
}
if (typeof normalizeOutlet !== 'function') {
  throw new Error('aggregator-url-latent: normalizeOutlet failed to load from review-normalization.js');
}

/**
 * Exactly validate-review-texts.js's outletId resolution (null-in/null-out around
 * the canonical normalizeOutlet). Deliberately does NOT fall back to `data.outlet`:
 * the validator's aggregator_url_mismatch check reads only normalizeOutletId(data.outletId),
 * and a ratchet that resolved outletId differently would count a different population
 * than the gate it exists to protect (Codex adversarial finding, task #1002).
 */
function resolveOutletId(id) {
  if (!id) return null;
  return normalizeOutlet(id);
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
/**
 * How far above the pinned ceiling the latent count may drift before the gate blocks.
 * See evaluateLatentPopulation for why this is not zero.
 */
const DEFAULT_GRACE_BAND = 3;

const VALIDATOR_EXCLUSION_FLAGS = Object.freeze([
  'duplicateOf',
  'duplicateTextOf',
  'wrongProduction',
  'wrongShow',
  'wrongUrl',
  'wrongAttribution',
  'isRoundupArticle',
  'rejectionReason',
  // isNotReview is the DURABLE form of rejectionReason. The note in
  // review-write-guard.js explains why rejectionReason is deliberately NOT in
  // PROTECTED_FIELDS (it is CI-derived and two scripts must be able to clear it) —
  // but that also means any re-scrape can silently strip it. On 2026-08-17 the LBO
  // roundup scrape did exactly that to
  // christmas-carol-goes-wrong-west-end-2026/telegraph--unknown.json: a 0-word LBO
  // boilerplate disclaimer that three LLMs had unanimously rejected as "not a
  // review" lost its rejectionReason, re-entered the validated population carrying
  // the aggregator URL, and failed the trunk on a zero-tolerance gate.
  // isNotReview + its Reason/SetAt/SetBy siblings ARE protected and are already
  // honoured by review-guards.js:2939 to exclude a file from the rebuild, so a
  // record marked "this is not a review" was already outside the review population
  // everywhere EXCEPT here. Adding it closes that gap.
  // Blast radius when added: 4 files carry isNotReview:true corpus-wide and all 4
  // were already excluded by another flag, so the validated population is unchanged
  // today (measured 2026-08-17). This is a durability guarantee, not a relaxation.
  'isNotReview',
  'suspectedMisattribution',
]);

/**
 * True when validate-review-texts.js skips this review entirely.
 * @param {object} data - parsed review JSON
 * @returns {boolean}
 */
/**
 * Flags whose exclusion requires STRICT `=== true`, not truthiness.
 *
 * The historical flags here are truthy-tested and must stay that way — several
 * carry a reason STRING rather than a boolean (rejectionReason is literally
 * "not_a_review"), so tightening them would silently re-admit thousands of files.
 *
 * isNotReview is different and must be strict. Every OTHER consumer tests it
 * `=== true` (review-guards.js:2939, rebuild-all-reviews.js:2873,
 * merge-review-fields.js:75). A truthy test here would create a divergence an
 * adversarial review named precisely: `isNotReview: "false"` — a string, and so
 * truthy — would silence this zero-tolerance validator while the record stayed
 * fully live for rebuild and scoring. Any process that can write a review JSON
 * could set it. Strict equality keeps this predicate in lockstep with everything
 * else that reads the flag, so it can never hide a record the rebuild still uses.
 */
const STRICT_TRUE_FLAGS = Object.freeze(['isNotReview']);

function isSkippedByValidator(data) {
  if (!data || typeof data !== 'object') return false;
  return VALIDATOR_EXCLUSION_FLAGS.some((flag) => (STRICT_TRUE_FLAGS.includes(flag)
    ? data[flag] === true
    : Boolean(data[flag])));
}

/**
 * True when the review's URL is an aggregator listing page while its outletId claims a
 * real outlet. Canonical for validate-review-texts.js's aggregator_url_mismatch check.
 *
 * CARVE-OUT (task #1194): a real-outlet file carrying a score sourced FROM the roundup
 * (aggregatorStars or originalScore) is a legitimate star-stub, not contamination — the
 * aggregator URL is the only URL that ever existed for it. This is the same carve-out
 * shouldSkipAggregatorUrlWrite() already applies at write time (the 2026-06-21 12-WET
 * false-positive incident referenced in aggregator-domains.js). Without it, arming
 * westendtheatre.com in AGGREGATOR_DOMAINS would turn ~60+ legitimate WET star-stubs
 * into aggregator_url_mismatch errors. Only an unscored real-outlet URL on an
 * aggregator domain — nothing worth preserving, just a wrong URL — stays a mismatch.
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
  const outletId = resolveOutletId(data.outletId);
  if (!AGGREGATOR_DOMAINS.has(hostname) || AGGREGATOR_OUTLET_IDS.has(outletId)) return false;
  return !hasPreservableAggregatorScore(data);
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
 * WHY THERE IS A GRACE BAND AND NOT A HAIR TRIGGER (Codex adversarial finding, #1002):
 * review-texts is a separate repo that bots mutate every ~2 minutes, and CI checks out
 * its `main` HEAD rather than a revision pinned to the triggering commit. A single bot
 * write between "PR queued" and "runner reaches checkout" would therefore fail an
 * unrelated merge under an exact ceiling — which is precisely the trunk-reddening
 * pathology this whole card exists to end. Adding a gate with that property would have
 * made the cure the disease.
 *
 * So this mirrors the duplicateOf gate the card explicitly praises: block on SPIKES,
 * not on ones and twos. A drift of a few files annotates loudly (::warning::) and
 * passes; a producer regression — historically 27 and 32 files at once — blows past the
 * band and fails. Zero enforcement would be worse; hair-trigger enforcement would be
 * worse still.
 *
 * Shrinkage never fails: a gate that fires when the number IMPROVES is pure churn.
 *
 * @param {number} observed - latent files found by the scan
 * @param {number} pinned - ceiling from scripts/.aggregator-url-latent.json
 * @param {number} [graceBand=3] - how far above the ceiling drift may go before failing
 * @returns {{ok: boolean, reason: string, ratchetTo: number|null, warn: boolean}}
 */
function evaluateLatentPopulation(observed, pinned, graceBand = DEFAULT_GRACE_BAND) {
  if (!Number.isInteger(observed) || observed < 0) {
    return { ok: false, reason: `observed count is not a non-negative integer: ${observed}`, ratchetTo: null, warn: false };
  }
  if (!Number.isInteger(pinned) || pinned < 0) {
    return { ok: false, reason: `pinned ceiling is not a non-negative integer: ${pinned}`, ratchetTo: null, warn: false };
  }
  if (!Number.isInteger(graceBand) || graceBand < 0) {
    return { ok: false, reason: `grace band is not a non-negative integer: ${graceBand}`, ratchetTo: null, warn: false };
  }
  if (observed > pinned + graceBand) {
    return {
      ok: false,
      reason: `latent aggregator-URL population SPIKED: ${observed} > ceiling ${pinned} + grace ${graceBand}. `
        + 'That is a producer regression writing aggregator listing URLs under real outletIds, '
        + 'not bot churn. Fix the producer and the files — do NOT raise the ceiling to go green.',
      ratchetTo: null,
      warn: false,
    };
  }
  if (observed > pinned) {
    return {
      ok: true,
      reason: `latent population drifted to ${observed} (ceiling ${pinned}, grace ${graceBand}) — `
        + 'within the bot-churn band, so not blocking, but a new bad file exists. Triage it before it spikes.',
      ratchetTo: null,
      warn: true,
    };
  }
  if (observed < pinned) {
    return {
      ok: true,
      reason: `latent population shrank to ${observed} (ceiling ${pinned}) — tighten the pin.`,
      ratchetTo: observed,
      warn: false,
    };
  }
  return { ok: true, reason: `latent population steady at ${observed} (ceiling ${pinned}).`, ratchetTo: null, warn: false };
}

/**
 * Was the scan complete enough for its count to mean anything?
 *
 * WHY (Codex adversarial finding, #1002): every read failure in the scanner is
 * swallowed by design — an unreadable dir, a dangling symlink, a corrupt JSON, a file
 * a bot replaced mid-scan. Each swallowed failure removes a file from the denominator,
 * so a HALF-SCANNED corpus reports a SMALLER latent count, which the ratchet would
 * otherwise read as "improved" and pass. A guard that turns green when it stops being
 * able to see is worse than no guard.
 *
 * So a pass requires the scan to have actually looked at the corpus: at least
 * `minScanned` files parsed, and read errors under `maxScanErrors`.
 *
 * @param {number} scanned - files successfully parsed
 * @param {number} scanErrors - files/dirs skipped due to read or parse failure
 * @param {{minScanned?: number, maxScanErrors?: number}} [limits]
 * @returns {{ok: boolean, reason: string}}
 */
function evaluateScanIntegrity(scanned, scanErrors, limits = {}) {
  const { minScanned = 0, maxScanErrors = 50 } = limits;
  if (!Number.isInteger(scanned) || scanned < 0) {
    return { ok: false, reason: `scanned count is not a non-negative integer: ${scanned}` };
  }
  if (scanned < minScanned) {
    return {
      ok: false,
      reason: `scan covered only ${scanned} files, below the floor of ${minScanned} — the corpus is `
        + 'missing or partially checked out, so the latent count is not trustworthy. '
        + 'Refusing to report a pass on a blind scan.',
    };
  }
  if (scanErrors > maxScanErrors) {
    return {
      ok: false,
      reason: `scan hit ${scanErrors} unreadable/unparseable entries (max ${maxScanErrors}) — `
        + 'too much of the corpus was invisible for the count to mean anything.',
    };
  }
  return { ok: true, reason: `scan integrity OK (${scanned} files, ${scanErrors} skipped).` };
}

module.exports = {
  DEFAULT_GRACE_BAND,
  VALIDATOR_EXCLUSION_FLAGS,
  STRICT_TRUE_FLAGS,
  resolveOutletId,
  isSkippedByValidator,
  hasAggregatorUrlMismatch,
  classifyReview,
  evaluateLatentPopulation,
  evaluateScanIntegrity,
};
