'use strict';

/**
 * Selector for BRO-4154: find review-text files nulled by the pre-2026-09-25
 * punctuation-sensitive show-mention bug (scripts/lib/show-title-variants.js),
 * so they can be re-collected via the normal collection path.
 *
 * The bug: collect-review-texts.js / content-quality.js counted show mentions
 * with a literal substring match against the shows.json title. A title with
 * subtitle punctuation ("Dog Man - The Musical" vs a review's "Dog Man: The
 * Musical") or separator punctuation ("Oh, Mary!" vs "Oh Mary!") normalized
 * differently on each side, so the literal count came back 0 and the review
 * was nulled (fullText -> wrongFullText, contentTier: 'stub',
 * incompleteReason: 'url_content_mismatch') even though it was a real review
 * of the right show. Shows whose title has NO such punctuation were not
 * affected by this bug — a 0-mention rejection there reflects something else
 * (wrong article, a one-word title never repeated in body prose, etc.) and
 * must not be swept into a blind re-collection.
 */

const fs = require('fs');
const path = require('path');
const { normalizeForMention, textMentionsTitle } = require('./show-title-variants');

const MENTION_REJECT_RE = /^show mentioned \d+× \(below/;

/**
 * Does this title contain punctuation whose spelling could plausibly differ
 * between shows.json and a review, such that normalizeForMention changes the
 * matchable string? A title with NO such punctuation was never at risk from
 * this bug.
 * @param {string} title
 * @returns {boolean}
 */
function titleNeedsNormalization(title) {
  if (!title || typeof title !== 'string') return false;
  return normalizeForMention(title) !== title.toLowerCase().trim();
}

/**
 * @param {object} data - parsed review-text JSON
 * @param {string} showTitle - canonical title from shows.json
 * @returns {{ candidate: boolean, reason: string }}
 */
function isPunctuationNulledCandidate(data, showTitle) {
  if (!data || !showTitle) return { candidate: false, reason: 'missing data/title' };

  if (!titleNeedsNormalization(showTitle)) {
    return { candidate: false, reason: 'title has no punctuation sensitive to normalization' };
  }

  // Already has usable text — nothing to recollect.
  if (data.fullText && data.fullText.length > 300) {
    return { candidate: false, reason: 'already has fullText' };
  }

  // Correctly-flagged signals: a real wrong-show/duplicate finding, not a
  // punctuation-driven mention-count miss. Leave these alone.
  if (data.duplicateOf) return { candidate: false, reason: 'duplicateOf set' };
  if (data.wrongShowReason) return { candidate: false, reason: 'wrongShowReason set' };
  // wrongShow/wrongProduction booleans are the canonical "confirmed wrong
  // show/production" signal used across the repo (review-guards.js, classify-
  // wrong-show.js, etc.) and commonly exist WITHOUT wrongShowReason — a stale
  // incompleteReason: 'url_content_mismatch' can sit alongside a fresh,
  // correct wrongShow: true if incompleteReason was never re-classified.
  if (data.wrongShow === true) return { candidate: false, reason: 'wrongShow set' };
  if (data.wrongProduction === true) return { candidate: false, reason: 'wrongProduction set' };
  if (data.contentVerification && (data.contentVerification.wrongArticle === true
    || data.contentVerification.wrongProduction === true
    || data.contentVerification.isFilmTv === true)) {
    return { candidate: false, reason: 'LLM-verified wrong article/production/film-tv' };
  }
  if (data.incompleteReason === 'wrong_content') {
    return { candidate: false, reason: 'wrong_content (manual/LLM flag, not a mention-count miss)' };
  }

  const rejectedOnMentionCount = data.incompleteReason === 'url_content_mismatch'
    && typeof data.incompleteDetail === 'string'
    && MENTION_REJECT_RE.test(data.incompleteDetail);
  const showNotMentionedSchema = data.showNotMentioned === true;
  if (!rejectedOnMentionCount && !showNotMentionedSchema) {
    return { candidate: false, reason: 'not a mention-count rejection' };
  }

  // Some files preserve the rejected text as wrongFullText. If it's present,
  // require the punctuation-tolerant matcher to actually find the show in it —
  // otherwise this really was the wrong article and re-collecting won't help.
  if (data.wrongFullText) {
    if (!textMentionsTitle(data.wrongFullText, showTitle)) {
      return { candidate: false, reason: 'wrongFullText still does not mention show under variant matching' };
    }
  }

  return {
    candidate: true,
    reason: rejectedOnMentionCount
      ? 'url_content_mismatch mention-count rejection on a punctuation-sensitive title'
      : 'showNotMentioned flag on a punctuation-sensitive title',
  };
}

/**
 * Walk a review-texts checkout and return every file that looks like it was
 * nulled by the punctuation bug.
 * @param {string} reviewTextsDir
 * @param {Record<string,string>} showTitleById - showId -> shows.json title
 * @returns {Array<{ showId: string, file: string, filePath: string, reason: string, url: string|null }>}
 */
function findPunctuationNulledFiles(reviewTextsDir, showTitleById) {
  const results = [];
  let showDirs;
  try {
    showDirs = fs.readdirSync(reviewTextsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('_'))
      .map((e) => e.name);
  } catch {
    return results;
  }

  for (const showId of showDirs) {
    const title = showTitleById[showId];
    if (!titleNeedsNormalization(title)) continue; // cheap skip before touching disk

    const dir = path.join(reviewTextsDir, showId);
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith('.json') || file === 'failed-fetches.json') continue;
      const filePath = path.join(dir, file);
      let data;
      try {
        data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch {
        continue;
      }
      const verdict = isPunctuationNulledCandidate(data, title);
      if (verdict.candidate) {
        results.push({ showId, file, filePath, reason: verdict.reason, url: data.url || null });
      }
    }
  }
  return results;
}

module.exports = {
  titleNeedsNormalization,
  isPunctuationNulledCandidate,
  findPunctuationNulledFiles,
};
