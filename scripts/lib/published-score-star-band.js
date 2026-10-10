'use strict';
/**
 * published-score-star-band.js (BRO-4839) — the one predicate for "a PUBLISHED score contradicts the critic's own
 * rating". A star or grade is a score band (CLAUDE.md section 3: 2/5 -> 31-50 ... 5/5 -> 91-100) and a review's score
 * must land in it whatever produced the score: the LLM, an adjudication, a human override or a relayed rating.
 * Found by BRO-4838: 189 of 23,170 published reviews sat outside their band (a printed 5/5 shown as 25, a printed 2/5
 * shown as 91 via an auto-accepted adjudication).
 *
 * Reuses humanScoreOutsideStarBand (detectBandFromReviewFile under the hood), so the band rules stay in one place and
 * only a HIGH-reliability rating binds the score (a junk generic-pattern star or a relayed aggregator value does not).
 *
 * Two independent tests:
 *   star-band       a high-reliability rating exists and the score is more than `tol` points outside its band
 *   models-unanimous every model agreed on a bucket ("All 3 models agree: Rave") and the score is more than
 *                   `unanimousTol` points outside that bucket's range
 */
const { humanScoreOutsideStarBand } = require('./human-score-star-guard');
const { scoreToBucket } = require('./score-extractors');

const DEFAULT_TOL = 2;
const DEFAULT_UNANIMOUS_TOL = 15;
// scoreToBucket's thresholds as ranges: Rave >=83, Positive 70-82, Mixed 55-69, Negative 35-54, Pan <35.
const BUCKET_RANGES = { Rave: [83, 100], Positive: [70, 82], Mixed: [55, 69], Negative: [35, 54], Pan: [0, 34] };

/** The outlet's own rating fields (starRating, originalRating, originalScore as a raw string or a 0-100 number), as detectBandFromReviewFile reads them. */
function hasPrimaryRating(data) {
  const has = (v) => v !== null && v !== undefined && v !== '';
  return has(data.starRating) || has(data.originalRating)
    || (typeof data.originalScore === 'string' && has(data.originalScore))
    || (typeof data.originalScore === 'number' && Number.isFinite(data.originalScore));
}

/** The bucket every model agreed on, from ensembleData.modelAgreement ("All 3 models agree: Rave"), or null. */
function unanimousBucket(data) {
  const text = data && data.ensembleData && data.ensembleData.modelAgreement;
  const m = /^All \d+ models agree: (\w+)/.exec(String(text || ''));
  return m && BUCKET_RANGES[m[1]] ? m[1] : null;
}

/**
 * @param {object} data   review-text JSON contents (the rating fields; its own assignedScore is ignored)
 * @param {number} score  the PUBLISHED score (reviews.json assignedScore)
 * @returns {{kind: 'star-band'|'models-unanimous', score: number, detail: string, floor: number, ceiling: number}|null}
 */
function publishedScoreViolation(data, score, { tol = DEFAULT_TOL, unanimousTol = DEFAULT_UNANIMOUS_TOL } = {}) {
  if (!data || typeof score !== 'number' || !Number.isFinite(score)) return null;
  // A rating that exists ONLY as an aggregator relay (aggregatorStars / wetStars) does not bind: the Guardian's
  // two-show page relayed the other show's 3/5 onto Oliver!, a 4-star review (human-score-star-guard.js: relays
  // must not block a correct score).
  const band = hasPrimaryRating(data) ? humanScoreOutsideStarBand(data, score) : null;
  if (band && (score < band.floor - tol || score > band.ceiling + tol)) {
    return { kind: 'star-band', score, floor: band.floor, ceiling: band.ceiling, detail: `star ${band.starsRaw} band ${band.floor}-${band.ceiling}` };
  }
  const bucket = unanimousBucket(data);
  if (bucket) {
    const [lo, hi] = BUCKET_RANGES[bucket];
    if (score < lo - unanimousTol || score > hi + unanimousTol) {
      return { kind: 'models-unanimous', score, floor: lo, ceiling: hi, detail: `all models ${bucket} (${lo}-${hi}); published bucket ${scoreToBucket(score)}` };
    }
  }
  return null;
}

/**
 * May the adjudication queue auto-accept `llmScore` after its attempts run out? Not when that score sits outside the
 * critic's own high-reliability rating: the review is sent back for a band-anchored rescore instead (BRO-4839: 39
 * auto-accepted adjudications published a printed 2/5 as 91).
 * @returns {{accept: true}|{accept: false, violation: object}}
 */
function autoAcceptVerdict(data, llmScore) {
  const violation = publishedScoreViolation(data, llmScore, { unanimousTol: Infinity }); // only the rating binds an auto-accept
  return violation ? { accept: false, violation } : { accept: true };
}

const MAX_AUTO_ACCEPT_REFUSALS = 2;

/**
 * What the adjudication queue does once an item's attempts run out. `accept` keeps the LLM score; `rescore` sends it
 * back for a band-anchored rescore; `block` stops after MAX_AUTO_ACCEPT_REFUSALS refusals (adjudicationAttempts
 * survives a rescore, so a file the scorer keeps placing outside its band would otherwise be re-queued and re-paid
 * for every day) and waits for a human to check the extracted rating.
 * @returns {{action: 'accept'|'rescore'|'block', refusals: number, violation?: object}}
 */
function autoAcceptOutcome(data, llmScore, { maxRefusals = MAX_AUTO_ACCEPT_REFUSALS } = {}) {
  const verdict = autoAcceptVerdict(data, llmScore);
  const prior = (data && data.autoAcceptRefusals) || 0;
  if (verdict.accept) return { action: 'accept', refusals: prior };
  const refusals = prior + 1;
  return { action: refusals > maxRefusals ? 'block' : 'rescore', refusals, violation: verdict.violation };
}

module.exports = { MAX_AUTO_ACCEPT_REFUSALS, autoAcceptOutcome, hasPrimaryRating, autoAcceptVerdict, DEFAULT_TOL, DEFAULT_UNANIMOUS_TOL, BUCKET_RANGES, unanimousBucket, publishedScoreViolation };
