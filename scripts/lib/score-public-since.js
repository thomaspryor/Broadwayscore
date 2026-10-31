'use strict';

/**
 * score-public-since.js — pure update logic for the score-regression floor's
 * timestamp store (Coverage Verdict S3, task #905).
 *
 * `cs` on a show's slim public file (public/data/shows/{id}.json, written by
 * generate-mobile-show-details.js) is set only when the show clears the
 * review-count threshold (the same gate as hasEnoughReviews in
 * src/config/score-buckets.ts) — so `cs != null` is the canonical "is this
 * show's score currently public" signal (CLAUDE.md: canonical-critic-scores.ts
 * already trusts this same field). This module just watches for the FIRST
 * time each show crosses that line and stamps it, append-only — once
 * stamped, a stamp is never updated, even if `cs` later goes null again (a dip
 * must not reset the score-regression floor's clock). The one exception is a
 * stamp from before the show opened (see isPlausibleStamp), which is pruned.
 */

/**
 * A stamp dated more than PRE_OPENING_GRACE_DAYS before the show's opening
 * date is not a real "score went public" moment: before opening the only
 * reviews a show can hold are another production's, attached transiently
 * (School Pictures 2026 was stamped 12 days before it opened, then the floor
 * kept showing a Critical Gold label on 1 review). Such stamps are never
 * written, and any already in the store are pruned.
 *
 * @param {Record<string,string>} prevStamps  {showId: isoTimestamp}
 * @param {Record<string,number|null>} csByShowId  {showId: cs value or null/undefined}
 * @param {string} nowIso
 * @param {Record<string,string|null|undefined>} [openingDateByShowId]  {showId: 'YYYY-MM-DD'}
 * @returns {{stamps: Record<string,string>, newlyStamped: string[], pruned: string[]}}
 */
function computeScorePublicSinceUpdates(prevStamps, csByShowId, nowIso, openingDateByShowId) {
  const opening = openingDateByShowId || {};
  const stamps = { ...(prevStamps || {}) };
  const newlyStamped = [];
  const pruned = [];
  for (const [showId, iso] of Object.entries(stamps)) {
    if (!isPlausibleStamp(iso, opening[showId])) {
      delete stamps[showId];
      pruned.push(showId);
    }
  }
  for (const [showId, cs] of Object.entries(csByShowId || {})) {
    if (cs == null) continue;
    if (stamps[showId]) continue; // already stamped — append-only, never overwritten
    if (!isPlausibleStamp(nowIso, opening[showId])) continue; // pre-opening: not a real public score
    stamps[showId] = nowIso;
    newlyStamped.push(showId);
  }
  return { stamps, newlyStamped, pruned };
}

const PRE_OPENING_GRACE_DAYS = 2;

/**
 * The date a stamp is checked against: the opening date, or, while that is
 * unknown, the first preview. Opening never comes before previews, so a
 * stamp more than the grace period before the first preview is also before
 * opening. Without this fallback a show with no opening date yet kept any
 * stamp (Christmas Carol Goes Wrong, previews in December, showed a score
 * on its page in October from another production's reviews).
 *
 * @param {{openingDate?: string | null, previewsStartDate?: string | null}} show
 * @returns {string | null}
 */
function stampReferenceDate(show) {
  return (show && (show.openingDate || show.previewsStartDate)) || null;
}

/** False when `stampIso` is more than the grace period before `openingDate`. */
function isPlausibleStamp(stampIso, openingDate) {
  if (!openingDate) return true;
  const stampMs = Date.parse(stampIso);
  const openMs = Date.parse(openingDate);
  if (!Number.isFinite(stampMs) || !Number.isFinite(openMs)) return true;
  return stampMs >= openMs - PRE_OPENING_GRACE_DAYS * 86400000;
}

module.exports = { computeScorePublicSinceUpdates, isPlausibleStamp, stampReferenceDate, PRE_OPENING_GRACE_DAYS };
