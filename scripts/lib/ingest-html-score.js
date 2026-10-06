'use strict';

/**
 * ingest-html-score.js — recover an outlet's explicit rating from page HTML
 * when a review is ingested WITH a normal body (BRO-4764).
 *
 * ingest-review-from-url.js used to run the outlet score extractors only when
 * body extraction came back empty (the paywalled UK star outlets). A normal
 * ingest wrote originalScore: null, so a rating carried only by the HTML — e.g.
 * 1minutecritic's <img alt="4 star review"> — was never recorded and the review
 * was scored by the LLM alone, with no star band (anchored-v6). Found on
 * slam-frank-off-broadway-2026 (Matthew Wexler, 4/5 scored 78 unanchored).
 *
 * Only outlets with a registered extractor are consulted, so generic
 * extractors cannot pull a stray "3/5" out of unrelated page chrome.
 *
 * @param {string} html      raw page HTML
 * @param {string} text      extracted article body
 * @param {string} outletId  canonical outlet id
 * @param {string} showTitle
 * @returns {{originalScore: string, normalizedScore: number, source: string}|null}
 */
function recoverScoreFromHtml(html, text, outletId, showTitle) {
  if (!html || !outletId) return null;
  const { extractScore, OUTLET_EXTRACTORS } = require('./score-extractors');
  if (!OUTLET_EXTRACTORS[outletId]) return null;
  return extractScore(html, text || '', outletId, showTitle) || null;
}

module.exports = { recoverScoreFromHtml };
