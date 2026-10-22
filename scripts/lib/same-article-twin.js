'use strict';

const { decideSameArticleNamedTwin } = require('./review-text-identity');

/**
 * rebuild-all-reviews.js drops a named file whose text is near-identical to an
 * already-kept file at the same outlet (SAME-ARTICLE TWIN, BRO-5398), using
 * decideSameArticleNamedTwin. verify-review-recovery.js must treat such a file
 * as deduped, not "scored but MISSING" (BRO-5726: thereviewshub--reviewer-upload.json
 * duplicates thereviewshub--christine-stanton.json, which has a different
 * first-500-char fingerprint because of a "Writers:" header line).
 *
 * @param {object} data the file that is absent from reviews.json
 * @param {object[]} others other parsed files of the same show that ARE in reviews.json
 * @returns {object|null} the surviving twin, or null
 */
function findSameArticleTwin(data, others) {
  if (!data || !data.fullText) return null;
  const sameOutlet = others.filter((o) => o && o !== data && o.outletId === data.outletId && o.fullText);
  const verdict = decideSameArticleNamedTwin(data.fullText, sameOutlet);
  return verdict.drop ? sameOutlet[verdict.index] : null;
}

module.exports = { findSameArticleTwin };
