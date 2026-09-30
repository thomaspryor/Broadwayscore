'use strict';

/**
 * What an LLM classifier gets to read, and when its non-review verdict must not
 * be stamped (BRO-4429).
 *
 * The content verifier read the first 2,500 chars and the Gemini non-review
 * pass read the first 2,000 + last 1,000. Both judged real reviews on the part
 * they saw: a review whose lead is background (NY Sun "Les Mis" history, a
 * TheaterMania set-up paragraph) became "feature"/"preview", a multi-show
 * column whose first section was another show became wrongProduction, and a
 * review stored behind a homepage JSON blob became "news".
 *
 * sampleTextForClassifier gives both the head, the tail and the passages that
 * mention the show. geminiNonReviewStampBlocker lists the records a head+tail
 * verdict must not overrule.
 */

const { stripLeadingJsonBlob, stripConsentLayerPrefix } = require('./text-cleaning');
const { normalizeForMention, buildShowTitleVariants, findVariantSpans } = require('./show-title-variants');
const { shouldSkipNonReviewStamp } = require('./flagged-recovery');

const SAMPLE_GAP = '\n\n[...]\n\n';
const MAX_MENTION_WINDOWS = 3;
const MIN_VARIANT_LENGTH = 4;

/**
 * Raw-text offsets of show-title mentions. findVariantSpans returns offsets
 * into normalizeForMention() text, which differs in length from the raw text
 * ("&" → " and ", folded diacritics, collapsed whitespace), so offsets are
 * mapped back proportionally. The windows around them are wide enough that
 * the small drift does not matter.
 */
function findMentionOffsets(text, showTitle) {
  if (!text || !showTitle) return [];
  const norm = normalizeForMention(text);
  if (!norm) return [];
  const scale = text.length / norm.length;
  const offsets = [];
  for (const v of buildShowTitleVariants(showTitle)) {
    if (v.length < MIN_VARIANT_LENGTH) continue;
    for (const [start] of findVariantSpans(norm, v)) offsets.push(Math.round(start * scale));
  }
  return [...new Set(offsets)].sort((a, b) => a - b);
}

/**
 * The text a classifier should read, within `budget` chars.
 *
 * Leading page-data JSON and consent-layer blocks are dropped first. A body that
 * fits the budget is returned whole. A longer one becomes head + up to three
 * windows around show-title mentions that fall between head and tail (or evenly
 * spaced middle windows when the title is never named there) + tail.
 *
 * @param {string} text
 * @param {string} showTitle - shows.json title
 * @param {{budget?: number}} [opts]
 * @returns {{text: string, sampled: boolean, length: number}} length = body length after stripping
 */
function sampleTextForClassifier(text, showTitle, { budget = 6000 } = {}) {
  const body = stripLeadingJsonBlob(stripConsentLayerPrefix(String(text || ''))).trim();
  if (body.length <= budget) return { text: body, sampled: false, length: body.length };

  const headLen = Math.floor(budget * 0.35);
  const tailLen = Math.floor(budget * 0.2);
  const windowLen = Math.floor((budget - headLen - tailLen) / MAX_MENTION_WINDOWS);
  const middleStart = headLen;
  const middleEnd = body.length - tailLen;

  // Mentions first, then evenly spaced middle points to fill the budget when
  // the title is named fewer than MAX_MENTION_WINDOWS times in the middle.
  const step = (middleEnd - middleStart) / (MAX_MENTION_WINDOWS + 1);
  const spaced = Array.from({ length: MAX_MENTION_WINDOWS }, (_, k) => Math.round(middleStart + step * (k + 1)));
  const mentions = findMentionOffsets(body, showTitle).filter((o) => o >= middleStart && o < middleEnd);

  // Greedy: keep a candidate only if its window overlaps none already kept.
  const windows = [];
  for (const c of [...mentions, ...spaced]) {
    if (windows.length >= MAX_MENTION_WINDOWS) break;
    const start = Math.max(middleStart, Math.min(c - Math.floor(windowLen / 4), middleEnd - windowLen));
    const end = Math.min(middleEnd, start + windowLen);
    if (windows.some(([s, e]) => start < e && end > s)) continue;
    windows.push([start, end]);
  }
  windows.sort((a, b) => a[0] - b[0]);

  const parts = [body.slice(0, headLen)];
  for (const [s, e] of windows) parts.push(body.slice(s, e));
  parts.push(body.slice(middleEnd));
  return { text: parts.join(SAMPLE_GAP), sampled: true, length: body.length };
}

/**
 * Why the Gemini non-review pass must NOT stamp isNonReview on this record, or
 * null when it may. A head+tail verdict does not overrule:
 *   - a human clear (nonReviewManualClear, or a wrongProduction / wrongShow /
 *     wrongArticle / isNotReview manual clear, which all assert the file is this
 *     show's review), or a human score;
 *   - a high-confidence content verifier that called it a review. Asymmetric on
 *     purpose: the verifier read the same kind of partial window, but a partial
 *     window can hide the verdict of a review, not invent one;
 *   - a bot-stub capture (nyt_bot_stub etc.): the text is the pre-wall fragment,
 *     so the verdict judges the fragment, not the article;
 *   - a short body from a review-marker URL (flagged-recovery RC2).
 * @param {object} data - review-text record
 * @returns {string|null}
 */
function geminiNonReviewStampBlocker(data) {
  if (!data) return null;
  if (data.nonReviewManualClear === true) return 'manual-clear:nonReview';
  if (data.wrongProductionManualClear === true) return 'manual-clear:wrongProduction';
  if (data.wrongShowManualClear === true) return 'manual-clear:wrongShow';
  if (data.wrongArticleManualClear === true) return 'manual-clear:wrongArticle';
  if (data.isNotReviewManualClear === true) return 'manual-clear:isNotReview';
  if (data.humanReviewScore != null) return 'human-score';
  const cv = data.contentVerification;
  if (cv && cv.articleType === 'review' && cv.wrongArticle !== true
      && (cv.articleTypeConfidence || cv.confidence) === 'high') {
    return 'cv-high-confidence-review';
  }
  // Lazy: content-quality is a 3.5k-line module and this one is loaded by
  // lighter callers that never reach this branch.
  const { hasBotStubTruncationSignal } = require('./content-quality');
  if (hasBotStubTruncationSignal(data)) return 'bot-stub-text';
  if (shouldSkipNonReviewStamp(data)) return 'short-extraction';
  return null;
}

module.exports = {
  sampleTextForClassifier,
  findMentionOffsets,
  geminiNonReviewStampBlocker,
  SAMPLE_GAP,
};
