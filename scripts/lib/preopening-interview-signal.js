'use strict';

/**
 * preopening-interview-signal.js (BRO-4895)
 *
 * Cheap deterministic pre-score check: is this file a pre-press-night
 * INTERVIEW/FEATURE piece rather than a review?
 *
 * Incident 2026-10-08: Variety's "Rent, Reborn: How Star Gaten Matarazzo,
 * Director Luke Sheppard and ... Are Giving the Musical Its Biggest Revival Yet"
 * (published the morning of press night) was single-model scored 78 and went
 * live as a T1 review. Root cause: opening-night-express.yml ran the scorer
 * WITHOUT --ensemble, so the multi-model not_a_review consensus never ran, and
 * the lone model even wrote "feature piece rather than a traditional review"
 * while still emitting a score.
 *
 * Signals (all required): publishDate on/before the show's openingDate (a real
 * review can also land same-day, so date alone is never enough), a body long
 * enough to be an article, and dense NAMED quote attributions ("..." Name says)
 * which is the structural fingerprint of an interview. Threshold calibrated on
 * the full review-texts corpus: 0 hits among scored pre-opening reviews except
 * a play whose characters are quoted as dialogue (6 attributions, below the
 * floor); every other hit was already a not_a_review rejection.
 */

const { isLaneReview } = require('./opening-night-lane/trust-model');

const MIN_BODY_CHARS = 1500;
const MIN_ATTRIBUTIONS = 7;
const MIN_PER_1000_WORDS = 3;

// `"...," Firstname Lastname says`  |  `Name says, "..."`
const NAMED_ATTRIBUTION = /[”"]\s*,?\s+(?:[A-Z][\w'’.-]+\s+){1,3}(?:says|recalls|explains|adds|tells\s+\w+)\b|\b[A-Z][\w'’.-]+\s+(?:says|recalls|explains|adds)\s*[,.:]?\s*[“"]/g;

function countNamedAttributions(text) {
  return (String(text || '').match(NAMED_ATTRIBUTION) || []).length;
}

/**
 * @param {Object} data - review-text JSON
 * @param {Object} [show] - shows.json record (needs openingDate)
 * @returns {{suspect: boolean, reason: string, attributions?: number}}
 */
function detectPreOpeningInterviewFeature(data, show) {
  const none = (reason) => ({ suspect: false, reason });
  if (!data || typeof data.fullText !== 'string') return none('no_fulltext');
  if (data.fullText.length < MIN_BODY_CHARS) return none('too_short');
  // A human decision (manual clear / human score) always wins over a heuristic.
  if (data.humanReviewScore != null || data.manuallyCleared || data.wrongShowManualClear || data.wrongProductionManualClear
      || data.manualContentTier || data._locked || data.isNonReview === false) {
    return none('human_override');
  }
  const opening = show && show.openingDate;
  if (!opening || !data.publishDate) return none('no_dates');
  // Plain string compare is only valid for ISO dates; anything else is inert.
  if (!/^\d{4}-\d{2}-\d{2}/.test(String(data.publishDate)) || !/^\d{4}-\d{2}-\d{2}/.test(String(opening))) return none('non_iso_date');
  // Opening-night lane reviews are aggregator-verified: heuristics stand down.
  if (isLaneReview(data, { openingDate: opening })) return none('lane_review');
  if (String(data.publishDate).slice(0, 10) > String(opening).slice(0, 10)) return none('published_after_opening');

  const n = countNamedAttributions(data.fullText);
  const words = data.fullText.trim().split(/\s+/).length;
  if (n < MIN_ATTRIBUTIONS || (n / words) * 1000 < MIN_PER_1000_WORDS) return none('low_attribution_density');
  return { suspect: true, reason: 'preopening_interview_feature', attributions: n };
}

module.exports = { detectPreOpeningInterviewFeature, countNamedAttributions, MIN_ATTRIBUTIONS, MIN_PER_1000_WORDS };
