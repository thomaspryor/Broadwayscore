/**
 * excerpt-contamination-audit.js — pure matching logic for
 * audit-cross-show-excerpt-contamination.js (BRO-461).
 *
 * BRO-115 found harry-potter-and-the-cursed-child-both-parts-west-end-2021/
 * london-theatre--unknown.json carrying a theStageExcerpt that was verbatim
 * Shadowlands content (wrong show entirely), byte-identical to the
 * wrongFullText already preserved on a sibling file that HAD been through the
 * fullText contentVerification LLM check. That check never runs on
 * excerpt-sourced fields (bwwExcerpt/dtliExcerpt/etc — see excerpt-fields.js),
 * so the same copy-into-wrong-show-dir failure mode is invisible to it.
 *
 * The detector here is deliberately simple: verbatim (post-normalization)
 * text duplication of a review's excerpt/fullText fields under a DIFFERENT
 * showId is itself the anomaly signal — a real, independently-written review
 * of Show A is never byte-identical to a real review of Show B. Near-miss
 * fuzzy matching is NOT attempted; the confirmed case (and the roundup
 * ingestion bug that causes this class) is exact-copy, not paraphrase.
 */

'use strict';

const { EXCERPT_FIELDS } = require('./excerpt-fields');

// Below this normalized length, short matches are far more likely to be
// legitimate shared boilerplate (a pull-quote, a common turn of phrase) than
// genuine cross-attribution. Matches this short are still recorded for
// visibility but never auto-flagged.
const MIN_MATCH_LENGTH = 40;

// At this length, an exact cross-show text match is confident enough to
// surface as 'high' — matches audit-cross-attribution-by-critic.js's own
// judgment that longer content overlap is decisive.
const HIGH_CONFIDENCE_LENGTH = 80;

function normalizeExcerptText(s) {
  if (!s) return '';
  return String(s)
    .normalize('NFKC')
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Strip year/market suffix so same-production revival-year collisions
 * (already owned by the URL-collision audit) can be told apart from genuine
 * cross-show contamination.
 */
function baseShowId(showId) {
  return String(showId || '')
    .replace(/-\d{4}$/, '')
    .replace(/-(?:off-)?(?:broadway|west-end|off-west-end)(?:-\d{4})?$/, '');
}

/**
 * Extract {field, text} pairs worth indexing/matching from a review-text
 * record. fullText/wrongFullText are included so contamination is detected
 * against content already caught (and preserved) by the fullText
 * contentVerification path — exactly the shape of the confirmed case, where
 * the excerpt-only file's theStageExcerpt matched a sibling's wrongFullText.
 */
function extractIndexableFields(data) {
  const out = [];
  if (!data) return out;
  for (const field of EXCERPT_FIELDS) {
    const val = data[field];
    if (typeof val === 'string' && val.trim()) out.push({ field, text: val });
  }
  if (typeof data.fullText === 'string' && data.fullText.trim()) {
    out.push({ field: 'fullText', text: data.fullText });
  }
  if (typeof data.wrongFullText === 'string' && data.wrongFullText.trim()) {
    out.push({ field: 'wrongFullText', text: data.wrongFullText });
  }
  return out;
}

/**
 * Build an in-memory index: normalizedText -> [{showId, file, field,
 * wrongShow, wrongProduction, criticName}]. `records` is an iterable of
 * {showId, file, data}.
 */
function buildExcerptIndex(records) {
  const index = new Map();
  for (const { showId, file, data } of records) {
    for (const { field, text } of extractIndexableFields(data)) {
      const norm = normalizeExcerptText(text);
      if (norm.length < MIN_MATCH_LENGTH) continue;
      let bucket = index.get(norm);
      if (!bucket) { bucket = []; index.set(norm, bucket); }
      bucket.push({
        showId,
        file,
        field,
        wrongShow: !!data.wrongShow,
        wrongProduction: !!data.wrongProduction,
        criticName: data.criticName || null,
      });
    }
  }
  return index;
}

/**
 * For a single target file's excerpt/fullText fields, find cross-show
 * matches recorded in `index`. Returns one entry per (targetField,
 * indexEntry) pair whose showId differs from targetShowId.
 */
function findCrossShowMatches(targetShowId, targetFile, data, index) {
  const matches = [];
  for (const { field, text } of extractIndexableFields(data)) {
    const norm = normalizeExcerptText(text);
    if (norm.length < MIN_MATCH_LENGTH) continue;
    const bucket = index.get(norm);
    if (!bucket) continue;
    for (const entry of bucket) {
      if (entry.showId === targetShowId) continue;
      matches.push({
        targetField: field,
        matchedShowId: entry.showId,
        matchedFile: entry.file,
        matchedField: entry.field,
        matchedWrongShow: entry.wrongShow,
        matchedWrongProduction: entry.wrongProduction,
        matchedCriticName: entry.criticName,
        matchLength: norm.length,
        sameBase: baseShowId(entry.showId) === baseShowId(targetShowId),
        confidence: norm.length >= HIGH_CONFIDENCE_LENGTH ? 'high' : 'medium',
        excerpt: text.slice(0, 300),
      });
    }
  }
  return matches;
}

/**
 * Conservative auto-flag gate: only exact matches of substantial length,
 * against a genuinely different production (not a same-title revival-year
 * collision — that's the existing URL-collision audit's job), corroborated
 * by the matched file ALREADY carrying a wrongProduction/wrongShow flag for
 * the identical content. This is exactly the confirmed case's shape: the
 * "unknown" excerpt-only file matched a sibling that had already been
 * caught by the fullText contentVerification check. Matches without that
 * corroboration still get reported but require manual verification before
 * flagging (per BRO-461's acceptance criteria on false positives).
 */
function shouldAutoFlag(match) {
  return (
    match.confidence === 'high' &&
    !match.sameBase &&
    (match.matchedWrongProduction || match.matchedWrongShow)
  );
}

/**
 * True when a record is STILL excerpt-only per BRO-115's own definition
 * (excerpt-backfill-eligibility.js): no fullText at all. A record that has
 * since been re-collected with real fullText already runs through the
 * fullText contentVerification LLM check on every enrich-reviews.yml pass —
 * that's the standing safety net BRO-461 exists because excerpt-only records
 * DON'T get. Matching a re-collected record's now-vestigial excerpt fields
 * (left over from before the re-collection) produces false positives: the
 * excerpt field can carry stale wrong-show text while fullText — the text
 * actually driving the current score — is a genuine, correct review.
 */
function stillExcerptOnly(data) {
  return !(data && data.fullText && data.fullText.trim());
}

module.exports = {
  MIN_MATCH_LENGTH,
  HIGH_CONFIDENCE_LENGTH,
  normalizeExcerptText,
  baseShowId,
  extractIndexableFields,
  buildExcerptIndex,
  findCrossShowMatches,
  shouldAutoFlag,
  stillExcerptOnly,
};
