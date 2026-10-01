'use strict';

/**
 * published-star-capture.js — record a critic's own star rating when it is
 * printed in the review text but was never stored in originalScore.
 *
 * Why (BRO-4486, 2026-10-01): review-file-writer.js never ran the outlet
 * extractors, so reviews that arrived through it (submit-review-form,
 * url-ingest, roundup ingest) were scored unanchored even when their text
 * ended "★★★☆☆". 30 llm-v6 files carried a trusted star run nobody read
 * (How Shakespeare Saved My Life NYSR 3/5, Electra Persona 3/5 scored 77,
 * The Cherry Orchard Culture Sauce 5/5 scored 79). Once originalScore is set,
 * the scorer anchors to the star's band on first scoring, and the existing
 * late-star path (late-star-anchor.js) re-anchors files already scored.
 *
 * Only star glyphs and spelled-out stars count, the same set rebuild-helpers.js
 * trusts for its inline text recovery (P0.75 TRUSTED_RECOVERY_SOURCES). A bare
 * "4/5" or a percentage in text can be a date, a quote or another show's
 * rating. It never writes humanReviewScore, so the LLM still reads the prose
 * within the star's band.
 */

const { extractScore, KNOWN_STAR_OUTLETS, OUTLET_EXTRACTORS } = require('./score-extractors');

const MIN_TEXT_LENGTH = 100;
const TEXT_STAR_SOURCES = new Set(['unicode-stars', 'unicode-stars-fallthrough', 'word-stars']);

function hasRealExtractor(outletId) {
  const extractor = OUTLET_EXTRACTORS[outletId];
  if (!extractor) return false;
  const probe = extractor('', '');
  return !(probe && probe.__skipGeneric);
}

/**
 * @param {object} data - review-text record
 * @returns {{ originalScore: string, originalScoreSource: string, originalScoreNormalized: number } | null}
 */
function findPublishedStarInText(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.originalScore != null && String(data.originalScore).trim() !== '') return null;
  // A cleared rating was a deliberate verdict (FP extraction, wrong element);
  // re-reading the same text would undo it.
  if (data.originalScoreCleared === true) return null;
  if (data.humanReviewScore != null) return null;
  const outletId = data.outletId;
  if (!outletId) return null;
  if (!KNOWN_STAR_OUTLETS.has(outletId) && !hasRealExtractor(outletId)) return null;
  const text = typeof data.fullText === 'string' ? data.fullText : '';
  if (text.length < MIN_TEXT_LENGTH) return null;
  let found;
  try {
    found = extractScore('', text, outletId, data.showTitle);
  } catch {
    return null;
  }
  if (!found || !TEXT_STAR_SOURCES.has(found.source)) return null;
  const n = found.normalizedScore;
  if (!Number.isFinite(n) || n < 1 || n > 100) return null;
  return {
    originalScore: found.originalScore,
    originalScoreSource: found.source,
    originalScoreNormalized: n,
  };
}

/**
 * Mutates `data` when a star is found. Returns true when it changed.
 */
function capturePublishedStar(data) {
  const found = findPublishedStarInText(data);
  if (!found) return false;
  Object.assign(data, found);
  data.originalScoreCapturedFrom = 'fullText';
  return true;
}

module.exports = { findPublishedStarInText, capturePublishedStar };
