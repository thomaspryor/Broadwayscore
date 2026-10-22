'use strict';

const { decideSameArticleNamedTwin } = require('./review-text-identity');

/**
 * rebuild-all-reviews.js drops a named file whose text is near-identical to an
 * already-kept named file at the same outlet (SAME-ARTICLE TWIN, BRO-5398), using
 * decideSameArticleNamedTwin. verify-review-recovery.js must treat such a file
 * as deduped, not "scored but MISSING" (BRO-5726: thereviewshub--reviewer-upload.json
 * duplicates thereviewshub--christine-stanton.json, which has a different
 * first-500-char fingerprint because of a "Writers:" header line).
 *
 * Known gap: the rebuild exempts a file under the outlet's defaultCritic from
 * this check (it goes to the fingerprint swap-to-default instead); this helper
 * does not, so such a file that is also near-identical to a kept one reads as deduped.
 *
 * @param {object} data the file that is absent from reviews.json
 * @param {object[]} candidates other parsed files of the same show
 * @param {(d: object) => boolean} isKept true when the file is represented in reviews.json
 * @param {(critic: string) => boolean} isUnknownCritic
 * @returns {object|null} the surviving twin, or null
 */
function findSameArticleTwin(data, candidates, isKept, isUnknownCritic) {
  if (!data || !data.fullText || !data.outletId) return null;
  // The rebuild only keeps NAMED critics as twin candidates (keptNamedByOutlet).
  const sameOutlet = candidates.filter((o) => o && o !== data && o.outletId === data.outletId
    && o.fullText && !isUnknownCritic(o.criticName) && isKept(o));
  const verdict = decideSameArticleNamedTwin(data.fullText, sameOutlet);
  return verdict.drop ? sameOutlet[verdict.index] : null;
}

module.exports = { findSameArticleTwin };
