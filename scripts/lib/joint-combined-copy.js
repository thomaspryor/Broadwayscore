'use strict';

/**
 * joint-combined-copy.js (BRO-4305) - one article that reviews several shows is
 * filed once per show, each copy flagged isCombinedReview with combinedWith
 * naming its siblings. The rebuild's cross-show text-fingerprint dedup treated
 * the later copies as contamination and dropped them (La Voce di New York's
 * three-play roundup counted under Benevolent only).
 *
 * isCombinedReview/combinedWith are stamped from URL sharing alone
 * (flag-combined-reviews.js), so they are not proof by themselves: a copied
 * file under the wrong show carries them too. A copy is joint only when the
 * canonical URLs match (query kept, so old NYT ?res= ids stay distinct), either
 * copy names the other (the flagger's lists can be one-sided, e.g. Benevolent lists only The Pass), and the text actually mentions THIS show's title.
 */

/**
 * @param {object} data  review file being judged (belongs to showId)
 * @param {string} showId
 * @param {{showId:string, url?:string, isCombinedReview?:boolean, combinedWith?:string[]}[]} keptCopies
 *   copies already registered under the same text fingerprint
 * @param {{title?:string}} [show]  the show record for showId
 * @returns {boolean} true when data is a joint copy of one multi-show article
 */
function isJointCombinedCopy(data, showId, keptCopies, show) {
  if (!data || data.isCombinedReview !== true || !Array.isArray(keptCopies)) return false;
  if (!show || !show.title || !data.fullText) return false;
  const { canonicalizeUrlForDedup } = require('./review-guards');
  const { textMentionsTitle } = require('./show-title-variants');
  const url = canonicalizeUrlForDedup(data.url);
  if (!url) return false;
  const mine = Array.isArray(data.combinedWith) ? data.combinedWith : [];
  const sibling = keptCopies.some((k) => k && k.isCombinedReview === true
    && canonicalizeUrlForDedup(k.url) === url
    && (mine.includes(k.showId) || (Array.isArray(k.combinedWith) && k.combinedWith.includes(showId))));
  if (!sibling) return false;
  return !!textMentionsTitle(data.fullText, show.title) || mentionsShortTitleAsWritten(data.fullText, show.title);
}

/**
 * textMentionsTitle skips variants under 4 characters, so a joint copy for
 * Red, Art, SIX, Elf or Tru never counted (BRO-7077, BRO-4305 Codex P2). This
 * path is already corroborated by a shared URL and a combinedWith link, so a
 * short title only has to appear as written: whole word, case-sensitive in
 * its title-case or upper-case form ("Red" or "RED", never prose "red").
 */
function mentionsShortTitleAsWritten(text, title) {
  const t = String(title || '').trim().replace(/[.!?,]+$/, '');
  const core = t.replace(/[^A-Za-z0-9]/g, '');
  if (!core || core.length >= 4 || core !== t) return false;
  const forms = new Set([t, t.charAt(0).toUpperCase() + t.slice(1).toLowerCase(), t.toUpperCase()]);
  return [...forms].some((f) => new RegExp(`(?<![A-Za-z0-9])${f}(?![A-Za-z0-9])`).test(text));
}

module.exports = { isJointCombinedCopy, mentionsShortTitleAsWritten };
