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
 * True when two showIds are the same production filed under two slugs —
 * the exact "duplicate show entry" shape the real corpus run surfaced (e.g.
 * can-i-be-frank-off-broadway-2026 vs
 * morgan-bassichis-can-i-be-frank-off-broadway-2026). baseShowId() alone
 * only strips a trailing year/market suffix, so it misses this: one base is
 * a hyphen-bounded suffix of the other. That's a legitimate content match
 * (same real production, correctly reviewed), not cross-show contamination
 * — flagging it wrongShow would be actively wrong, not just noisy.
 */
function isDuplicateSlugPair(showIdA, showIdB) {
  const a = baseShowId(showIdA);
  const b = baseShowId(showIdB);
  if (!a || !b) return false;
  if (a === b) return true;
  return a.endsWith(`-${b}`) || b.endsWith(`-${a}`);
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
  // Roundups/combined-reviews legitimately share content across multiple
  // show dirs by design (one article covering several shows) — matching
  // exact-attribution logic against them produces false positives.
  // audit-cross-attribution-by-critic.js excludes them for the same reason
  // (scripts/audit-cross-attribution-by-critic.js:334).
  if (data.isRoundupArticle || data.isCombinedReview) return out;
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

// Matches a corroborating flag set because the content isn't a review of
// ANY show ("domain for sale" parked-page junk, ad spam, showNotMentioned) —
// as opposed to being identifiably a review of a DIFFERENT, specific show.
// Verified against the real corpus: enron-2010/equus-2008/la-bete-2010's
// shared new-jersey-newsroom files and ink-2019/be-more-chill-2019's shared
// theater-news-online files are both ad-spam/parked-domain junk that reached
// wrongProduction/wrongShow=true for exactly this "not a review" reason, not
// because the text was traced to a specific other production. Corroboration
// from a flag set for this reason doesn't establish genuine cross-show
// attribution — it just means BOTH copies are garbage.
const NOT_REVIEW_REASON_PATTERN = /not a review|domain (?:name )?for sale|no information about the show|does not mention the show|not about the show/i;

function isGarbageNotReviewCorroboration(entry) {
  if (entry.showNotMentioned) return true;
  const reason = `${entry.wrongShowReason || ''} ${entry.wrongProductionReason || ''}`;
  return NOT_REVIEW_REASON_PATTERN.test(reason);
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
        showNotMentioned: !!data.showNotMentioned,
        wrongShowReason: data.wrongShowReason || null,
        wrongProductionReason: data.wrongProductionReason || null,
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
        sameBase: isDuplicateSlugPair(entry.showId, targetShowId),
        confidence: norm.length >= HIGH_CONFIDENCE_LENGTH ? 'high' : 'medium',
        isGarbageNotReview: isGarbageNotReviewCorroboration(entry),
        excerpt: text.slice(0, 300),
      });
    }
  }
  return matches;
}

/**
 * Conservative auto-flag gate: only exact matches of substantial length,
 * against a genuinely different production (not a duplicate-slug pair or a
 * same-title revival-year collision — those are legitimate content matches,
 * not contamination; the revival case is the existing URL-collision audit's
 * job), corroborated by the matched entry's field being `wrongFullText`
 * specifically. wrongFullText is ONLY populated when the fullText
 * contentVerification LLM check has already verified THIS EXACT text is
 * wrong-show content (see excerpt-fields.js/scorable-text.js) — that's a
 * much stronger, more specific signal than a bare wrongProduction/wrongShow
 * boolean, which could be true for a reason unrelated to the matched text
 * (e.g. a different field on the same file was flagged). Requiring the
 * corroborating field itself ties the flag to verified-wrong CONTENT, not
 * just a flagged FILE, closing the coincidental-boilerplate-match risk a
 * bare boolean check would leave open. This is exactly the confirmed BRO-115
 * case's shape: the "unknown" excerpt-only file's theStageExcerpt matched a
 * sibling's wrongFullText, AND that sibling has wrongProduction/wrongShow
 * set. wrongFullText alone is NOT sufficient corroboration — it can also
 * hold plain scraper-quality garbage (ad/parked-domain junk) with no
 * wrongProduction/wrongShow flag at all (verified against the real corpus:
 * enron-2010 and equus-2008's new-jersey-newsroom files both carry the
 * identical ad-spam wrongFullText with wrongProduction/wrongShow undefined —
 * that's showNotMentioned/partial_text scraper failure, not cross-show
 * content, and flagging it wrongShow would be wrong). Both signals are
 * required together. Matches without that corroboration still get reported
 * but require manual verification before flagging (per BRO-461's acceptance
 * criteria on false positives).
 */
function shouldAutoFlag(match) {
  return (
    match.confidence === 'high' &&
    !match.sameBase &&
    match.matchedField === 'wrongFullText' &&
    (match.matchedWrongProduction || match.matchedWrongShow) &&
    !match.isGarbageNotReview
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
  isDuplicateSlugPair,
  isGarbageNotReviewCorroboration,
  extractIndexableFields,
  buildExcerptIndex,
  findCrossShowMatches,
  shouldAutoFlag,
  stillExcerptOnly,
};
