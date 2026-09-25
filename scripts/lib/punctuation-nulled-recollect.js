'use strict';

/**
 * Selector for BRO-4154: find review-text files that url_content_mismatch /
 * showNotMentioned nulled BEFORE the punctuation-tolerant show-mention
 * validators landed (scripts/lib/show-title-variants.js, main@ccc30e3d5d).
 *
 * fullText is gone by the time a file qualifies, so there is no review body
 * left to re-normalize. The best surviving signal of what the article is
 * actually about is its own URL slug — collection sources review URLs from
 * the outlet's own review title, so "dog-man-the-musical-west-end-2026"'s
 * theatreweekly.com URL is ".../review-dog-man-the-musical-at-queen-elizabeth-hall/".
 * Reusing show-title-variants.js's punctuation-tolerant matcher against the
 * de-hyphenated slug (not re-implementing normalization) tells punctuation
 * victims (slug names the right show) apart from genuinely wrong-show
 * mismatches (slug names a different show/article entirely, e.g. a
 * "man-and-boy" URL that got mis-associated with the "golden-boy" show).
 */

const { textMentionsTitle } = require('./show-title-variants');

const NULLING_REASONS = new Set(['url_content_mismatch']);

/**
 * @param {string} url
 * @returns {string} the URL path with slug separators turned into spaces,
 *   ready for normalizeForMention/textMentionsTitle.
 */
function urlToSlugText(url) {
  if (!url) return '';
  let pathname;
  try {
    pathname = new URL(url).pathname;
  } catch {
    pathname = String(url);
  }
  // Slugs use hyphens purely as word separators (never an intentional
  // intra-word hyphen the way prose does), unlike normalizeForMention's
  // "Spider-Man stays one token" prose rule — split every hyphen here so the
  // normalizer downstream sees "dog man the musical", not "dog-man-the-musical".
  return pathname.replace(/[/_-]+/g, ' ');
}

/**
 * Was this review file nulled by the punctuation-matching bug (as opposed to
 * a genuinely different/wrong show)?
 * @param {object} review - parsed review-texts JSON
 * @param {string} showTitle - shows.json title for the show this file lives under
 * @returns {boolean}
 */
function isPunctuationNulledCandidate(review, showTitle) {
  if (!review || !showTitle) return false;
  if (review.fullText) return false; // text present — not nulled, out of scope
  const nulledByMismatch = NULLING_REASONS.has(review.incompleteReason) || review.showNotMentioned === true;
  if (!nulledByMismatch) return false;
  const slugText = urlToSlugText(review.url);
  if (!slugText) return false;
  return textMentionsTitle(slugText, showTitle) !== null;
}

/**
 * Scan a review-texts checkout for punctuation-nulled candidates.
 * @param {string} reviewTextsDir - path to a review-texts checkout (top-level
 *   dirs are showIds; _pending/<showId>/... is skipped, same as elsewhere)
 * @param {Map<string,string>|Record<string,string>} showTitlesById
 * @param {{readdirSync?: Function, readFileSync?: Function, existsSync?: Function}} [deps]
 * @returns {Array<{showId: string, file: string, path: string, url: string, incompleteReason: string|undefined}>}
 */
function findPunctuationNulledFiles(reviewTextsDir, showTitlesById, deps = {}) {
  const fs = require('fs');
  const path = require('path');
  const readdirSync = deps.readdirSync || fs.readdirSync;
  const readFileSync = deps.readFileSync || fs.readFileSync;
  const existsSync = deps.existsSync || fs.existsSync;

  const titleFor = (showId) => (showTitlesById instanceof Map ? showTitlesById.get(showId) : showTitlesById[showId]);

  const out = [];
  let showDirs;
  try {
    showDirs = readdirSync(reviewTextsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== '_pending' && e.name !== '_superseded-misattributed')
      .map((e) => e.name);
  } catch {
    return out;
  }

  for (const showId of showDirs) {
    const title = titleFor(showId);
    if (!title) continue;
    const showDir = path.join(reviewTextsDir, showId);
    let files;
    try {
      files = readdirSync(showDir).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }
    for (const file of files) {
      const filePath = path.join(showDir, file);
      if (!existsSync(filePath)) continue;
      let review;
      try {
        review = JSON.parse(readFileSync(filePath, 'utf8'));
      } catch {
        continue;
      }
      if (isPunctuationNulledCandidate(review, title)) {
        out.push({ showId, file, path: filePath, url: review.url, incompleteReason: review.incompleteReason });
      }
    }
  }
  return out;
}

module.exports = {
  urlToSlugText,
  isPunctuationNulledCandidate,
  findPunctuationNulledFiles,
};
