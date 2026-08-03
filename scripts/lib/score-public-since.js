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
 * stamped, a stamp is never removed or updated, even if `cs` later goes
 * null again (a dip must not reset the score-regression floor's clock).
 */

/**
 * @param {Record<string,string>} prevStamps  {showId: isoTimestamp}
 * @param {Record<string,number|null>} csByShowId  {showId: cs value or null/undefined}
 * @param {string} nowIso
 * @returns {{stamps: Record<string,string>, newlyStamped: string[]}}
 */
function computeScorePublicSinceUpdates(prevStamps, csByShowId, nowIso) {
  const stamps = { ...(prevStamps || {}) };
  const newlyStamped = [];
  for (const [showId, cs] of Object.entries(csByShowId || {})) {
    if (cs == null) continue;
    if (stamps[showId]) continue; // already stamped — append-only, never overwritten
    stamps[showId] = nowIso;
    newlyStamped.push(showId);
  }
  return { stamps, newlyStamped };
}

module.exports = { computeScorePublicSinceUpdates };
