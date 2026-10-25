'use strict';

/**
 * joint-combined-copy.js (BRO-4305) - one article that reviews several shows is
 * filed once per show, each copy flagged isCombinedReview with combinedWith
 * naming its siblings. The rebuild's cross-show text-fingerprint dedup treated
 * the later copies as contamination and dropped them (La Voce di New York's
 * three-play roundup counted under Benevolent only). Copies that name each
 * other as joint coverage of the same URL are legitimate and must all count.
 */

function _canonUrl(u) {
  return String(u || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
}

/**
 * @param {object} data  review file being judged (belongs to showId)
 * @param {string} showId
 * @param {{showId:string, url?:string, isCombinedReview?:boolean, combinedWith?:string[]}} kept
 *   the copy that already owns the fingerprint
 * @returns {boolean} true when both are joint copies of one multi-show article
 */
function isJointCombinedCopy(data, showId, kept) {
  if (!data || !kept || data.isCombinedReview !== true || kept.isCombinedReview !== true) return false;
  const url = _canonUrl(data.url);
  if (!url || url !== _canonUrl(kept.url)) return false;
  const mine = Array.isArray(data.combinedWith) ? data.combinedWith : [];
  const theirs = Array.isArray(kept.combinedWith) ? kept.combinedWith : [];
  return mine.includes(kept.showId) || theirs.includes(showId);
}

module.exports = { isJointCombinedCopy };
