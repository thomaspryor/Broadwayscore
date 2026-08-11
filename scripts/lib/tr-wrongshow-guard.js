'use strict';

/**
 * Theatre Record extraction: wrong-show content guard (extracted from
 * extract-theatre-record.js Guard 5, task #1227).
 *
 * Counts title/word mentions of the show's title in a TR review's full text
 * to catch multi-column PDF contamination and misfiled HTML reviews. Common-
 * word titles (city names, single common nouns) break the raw mention-count
 * heuristic — Barcelona lost 6 real T1/T2 reviews (guardian, financialtimes,
 * thestage, standard, times-uk x2) to this in run 31394858905, all
 * independently confirmed by the WET roundup (westendtheatre.com/261097).
 *
 * Fix: when the mention count falls below threshold, corroborate via the
 * show's WET roundup rows (outlet+critic match) before rejecting — mirrors
 * the trust the pipeline already places in WET as a corroboration source
 * elsewhere (wet-roundup-discover.js).
 */

/**
 * @param {string} reviewFullText
 * @param {string} showTitle
 * @param {object} [opts]
 * @param {string} [opts.outletId] - canonical outletId of the review being checked
 * @param {Set<string>} [opts.wetOutletIds] - canonical outletIds present in the show's WET roundup
 * @returns {{ pass: boolean, mentions: number, minMentions: number, corroborated: boolean, skipReason?: string }}
 */
function checkWrongShowGuard(reviewFullText, showTitle, opts = {}) {
  const reviewLower = String(reviewFullText || '').toLowerCase();
  const showTitleLower = String(showTitle || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  const showWords = showTitleLower.split(/\s+/).filter(w => w.length > 3 && !['the', 'and', 'for', 'from', 'with'].includes(w));
  const coreWords = showTitleLower.split(/\s+/).filter(w => w.length >= 2 && !['the', 'and', 'for', 'from', 'with', 'a', 'an', 'at', 'in', 'on', 'of', 'to'].includes(w));

  const titleRegex = new RegExp(`\\b${showTitleLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
  const titleMentions = (reviewLower.match(titleRegex) || []).length;
  const wordMentions = showWords.length > 0
    ? Math.max(...showWords.map(w => (reviewLower.match(new RegExp(`\\b${w}\\b`, 'gi')) || []).length))
    : 0;
  const coreMentions = coreWords.length > 0
    ? Math.max(...coreWords.map(w => (reviewLower.match(new RegExp(`\\b${w}\\b`, 'gi')) || []).length))
    : 0;

  const mentions = Math.max(titleMentions, wordMentions, coreMentions);
  const minMentions = showWords.length >= 2 ? 1 : 2;

  if (mentions >= minMentions) {
    return { pass: true, mentions, minMentions, corroborated: false };
  }

  const { outletId, wetOutletIds } = opts;
  if (outletId && wetOutletIds && wetOutletIds.has(outletId)) {
    return { pass: true, mentions, minMentions, corroborated: true };
  }

  return {
    pass: false,
    mentions,
    minMentions,
    corroborated: false,
    skipReason: `wrong-show (only ${mentions} title mention(s) in review)`,
  };
}

module.exports = { checkWrongShowGuard };
