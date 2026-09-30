'use strict';

/**
 * contamination-allow-signal.js — turn a "this tour/film signal is a false
 * positive" verdict into the override the inclusion guards actually read.
 *
 * The tour/film contamination safety net (review-guards.js explainExclusion
 * and rebuild-all-reviews.js, both scanning fullText.slice(0, 600) with
 * isTourReviewExcerpt / isFilmTvReview) only honours `allowTourSignal` /
 * `allowFilmSignal`. adjudicate-review-queue.js used to record a legit verdict
 * only as `tourCheckVerified: 'false-positive'`, which neither guard reads, so
 * adjudicated-legit reviews stayed excluded as tourContaminationInText forever
 * (almost-famous-2022 nyt-theater: "on tour" = the band in the story).
 *
 * Pure: no fs, no process.
 */

const { isTourReviewExcerpt, tourContextForShow, isFilmTvReview } = require('./excerpt-validation');

// The two queue reasons rebuild-all-reviews.js files for these guards
// (flagForHumanReview 'possible-tour-fulltext' / 'possible-film-tv-fulltext').
const REASON_TO_KIND = {
  'possible-tour-fulltext': 'tour',
  'possible-film-tv-fulltext': 'film',
};

/**
 * Fields that make the matching guard stand down.
 *
 * @param {'tour'|'film'} kind
 * @param {string} reason - why the signal is a false positive (stored verbatim)
 * @returns {object} fields to assign onto the review record ({} for an unknown kind)
 */
function contaminationAllowFields(kind, reason) {
  if (kind === 'tour') return { allowTourSignal: true, allowTourSignalReason: reason };
  if (kind === 'film') return { allowFilmSignal: true, allowFilmSignalReason: reason };
  return {};
}

const ALLOW_FIELDS = ['allowTourSignal', 'allowTourSignalReason', 'allowFilmSignal', 'allowFilmSignalReason'];

/**
 * Assign the allow flag for `kind`, first recording any allow* values it
 * overwrites in allowSignalHistory[] (a human's earlier reason must not be
 * silently replaced by an automated one). Mutates.
 *
 * @returns {boolean} true when fields were set
 */
function applyContaminationAllow(d, kind, reason, at) {
  const fields = contaminationAllowFields(kind, reason);
  if (!d || !Object.keys(fields).length) return false;
  const previous = {};
  for (const f of ALLOW_FIELDS) {
    if (f in fields && d[f] != null && d[f] !== fields[f]) previous[f] = d[f];
  }
  if (Object.keys(previous).length) {
    const history = Array.isArray(d.allowSignalHistory) ? d.allowSignalHistory : [];
    d.allowSignalHistory = [...history, { replacedAt: at || new Date().toISOString(), ...previous }];
  }
  Object.assign(d, fields);
  return true;
}

/** Map an adjudication-queue reason to 'tour' | 'film' | null. */
function contaminationKindForQueueReason(queueReason) {
  return REASON_TO_KIND[queueReason] || null;
}

/**
 * Which allow flag(s) the current fullText actually needs — re-runs the same
 * detectors the guards run, on the same 600-char intro. Used by the backfill,
 * where the original queue reason is no longer on the file.
 *
 * @param {object} data - review record
 * @param {object} [show] - shows.json entry (for tourContextForShow)
 * @returns {Array<'tour'|'film'>} kinds whose detector fires and whose flag is not yet set
 */
function contaminationKindsNeeded(data, show) {
  if (!data || typeof data.fullText !== 'string' || !data.fullText) return [];
  const intro = data.fullText.slice(0, 600);
  const kinds = [];
  if (!data.allowTourSignal && isTourReviewExcerpt(intro, tourContextForShow(show)).isTourReview) kinds.push('tour');
  if (!data.allowFilmSignal && isFilmTvReview(intro).isFilmTv) kinds.push('film');
  return kinds;
}

/**
 * The single allow flag a legit verdict may grant. The adjudicator judged ONE
 * signal; when both detectors fire, granting both would waive a check nobody
 * adjudicated, so grant none and let a person look.
 *
 * @returns {{kind: 'tour'|'film'|null, ambiguous: boolean}}
 */
function pickContaminationAllowKind(data, show) {
  const kinds = contaminationKindsNeeded(data, show);
  if (kinds.length === 1) return { kind: kinds[0], ambiguous: false };
  return { kind: null, ambiguous: kinds.length > 1 };
}

module.exports = {
  applyContaminationAllow,
  pickContaminationAllowKind,
  contaminationAllowFields,
  contaminationKindForQueueReason,
  contaminationKindsNeeded,
};
