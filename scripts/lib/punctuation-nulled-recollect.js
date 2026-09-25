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

// Other diagnosed root causes that also leave showNotMentioned:true set as a
// secondary flag but are NOT the punctuation-title-matching bug: a cross-
// attributed/tour-vs-Broadway review (wrongShow, crossAttributionAudit), a
// scraper that fetched an unrelated page (garbageFullText/_invalidatedFullText,
// contentTier 'invalid'), or a genuinely short/incomplete fetch (partial_text,
// paywall, scraper_garbage). Real audit of the 2026-09-24 corpus found all of
// these co-occurring with showNotMentioned:true and a URL that happens to
// name the right show — recollecting them would be a no-op or, for the
// cross-attribution cases, actively wrong.
const OTHER_ROOT_CAUSE_REASONS = new Set(['wrong_content', 'partial_text', 'paywall', 'scraper_garbage']);

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
  // A different, already-diagnosed root cause owns this file — never the
  // punctuation bug even when showNotMentioned:true is also set.
  if (review.wrongShow === true) return false;
  if (review.crossAttributionAudit) return false;
  if (review.garbageFullText || review._invalidatedFullText) return false;
  if (review.contentTier === 'invalid') return false;
  if (review.incompleteReason && OTHER_ROOT_CAUSE_REASONS.has(review.incompleteReason)) return false;
  // "titleMatch=true" in incompleteDetail means validateContentMentionsShow
  // already re-ran its full (HTML <title> + punctuation-tolerant body mention)
  // check on the real fetched page and STILL rejected it for too few body
  // mentions — a genuine low-mention-count case, not a stale pre-fix literal-
  // match miss. Recollecting cannot rescue these (real corpus example:
  // and-juliet-2022/guardian--unknown.json is a "Romeo and Juliet" review
  // whose URL slug happens to contain "and juliet").
  if (/titleMatch=true/.test(review.incompleteDetail || '')) return false;

  const nulledByMismatch = NULLING_REASONS.has(review.incompleteReason)
    || (review.showNotMentioned === true && !review.incompleteReason);
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
