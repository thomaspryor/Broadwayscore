'use strict';
/**
 * BRO-2788: the one way a review body is set aside as wrong content.
 *
 * Wrong-production / wrong-show / not-a-review / content-mismatch verdicts move
 * the scraped body from fullText to wrongFullText (kept for audit). The tier
 * reclassification that follows derives wordCount from fullText, so the
 * record then reads wordCount 0 exactly like a review that was never scraped.
 * Audits and opening-night monitors took that as "not collected" and planned
 * re-fetches of bodies already on disk (the-story-west-end-2026
 * theatrecat--unknown.json: 682 words sat in wrongFullText while the monitor
 * read wordCount 0 and queued an ingest-review-from-url.js re-fetch).
 *
 * quarantineBody() stamps quarantinedWordCount alongside the move, and
 * describeTextState() is what readers ask instead of looking at wordCount.
 * wordCount itself keeps meaning "words in fullText" (audit-field-consistency
 * checks it against the text), so it is not faked.
 */

function countWords(text) {
  if (typeof text !== 'string') return 0;
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

/**
 * Move fullText to wrongFullText and record its word count. Mutates `data`.
 * A record with no body is left alone.
 * @returns {boolean} true when a body was quarantined
 */
function quarantineBody(data) {
  if (!data) return false;
  if (typeof data.fullText !== 'string' || !data.fullText.trim()) {
    // Nothing to keep, but the caller's verdict still empties the live body.
    if (typeof data.fullText === 'string') data.fullText = null;
    return false;
  }
  data.wrongFullText = data.fullText;
  data.fullText = null;
  data.quarantinedWordCount = countWords(data.wrongFullText);
  // A new verdict: the body parked now is wrong content again (BRO-5261 S11).
  if (data.releasedBodyRestoredAt) data.releasedBodyRestoredAt = null;
  return true;
}

/**
 * What text a record holds:
 *   { state: 'present', words }      fullText on disk
 *   { state: 'quarantined', words }  no fullText, body set aside in wrongFullText
 *   { state: 'none', words: 0 }      nothing scraped (or nothing kept)
 */
function describeTextState(data) {
  if (!data) return { state: 'none', words: 0 };
  if (typeof data.fullText === 'string' && data.fullText.trim()) {
    return { state: 'present', words: countWords(data.fullText) };
  }
  if (typeof data.wrongFullText === 'string' && data.wrongFullText.trim()) {
    const words = Number.isInteger(data.quarantinedWordCount) && data.quarantinedWordCount > 0
      ? data.quarantinedWordCount
      : countWords(data.wrongFullText);
    return { state: 'quarantined', words };
  }
  return { state: 'none', words: 0 };
}

// BRO-2851: a released verdict that never got its body back. A wrongProduction
// override or manual clear restores wrongFullText only when fullText is empty
// (clear-own-venue-tour-fps-2026-10.js and friends), so a file that took a
// shorter re-fetch in the meantime keeps a stub live and its full review
// parked: john-proctor-is-the-villain-west-end-2026/new-statesman--emily-lawford.json
// held 149 words live and the 505-word review in wrongFullText, never scored.
const MIN_RESTORE_CHARS = 200;
const LONGER_RATIO = 1.5;

/**
 * Should the quarantined body go back into fullText?
 * Only after an EXPLICIT release (human clear or override; script auto-clears
 * do not count: the dateless-revival release put a 2025 London Much Ado review
 * on the 2026 Broadway show), with no live exclusion left, on non-garbage
 * text, and either no live text or a live text that is a shorter copy of the
 * same article.
 * @param {object} data
 * @param {{isGarbage: (t: string) => boolean, sameArticle: (a: string, b: string) => boolean}} deps
 * @returns {{ok: boolean, reason: string}}
 */
function releasedBodyRestoreVerdict(data, deps) {
  if (!data) return { ok: false, reason: 'no record' };
  const parked = typeof data.wrongFullText === 'string' ? data.wrongFullText : '';
  if (parked.trim().length < MIN_RESTORE_CHARS) return { ok: false, reason: 'no quarantined body' };
  if (data._locked === true) return { ok: false, reason: '_locked' };
  for (const f of ['wrongProduction', 'wrongShow', 'isNonReview', 'showNotMentioned']) {
    if (data[f] === true) return { ok: false, reason: `still excluded (${f})` };
  }
  if (data.duplicateOf) return { ok: false, reason: 'still excluded (duplicateOf)' };
  // Quarantines that set none of the flags above: a content mismatch, a
  // not-a-review verdict, a suspected LLM hallucination or a wrong-article CV.
  // A release of some other verdict does not speak for these.
  if (data.contentMismatchNote) return { ok: false, reason: 'quarantined for content mismatch' };
  if (data.incompleteReason === 'non_review' || data.suspectedLlmHallucination === true) {
    return { ok: false, reason: `quarantined as ${data.incompleteReason === 'non_review' ? 'not a review' : 'suspected hallucination'}` };
  }
  // flagged-recovery discardWrongPageFill sets no exclusion flag (BRO-5261 S11).
  if (data.incompleteReason === 'wrong_page_served') return { ok: false, reason: 'quarantined as a wrong page served' };
  if (data.wrongArticle === true) return { ok: false, reason: 'still excluded (wrongArticle)' };
  if (data.contentVerification && data.contentVerification.wrongArticle === true) return { ok: false, reason: 'contentVerification says wrong article' };
  const released = data.wrongProductionManualClear === true || data.wrongProductionOverride === true
    || data.wrongShowManualClear === true || data.humanReviewedWrongProduction === false;
  if (!released) return { ok: false, reason: 'no explicit human/override release' };
  if (deps.isGarbage(parked)) return { ok: false, reason: 'quarantined body is garbage' };
  const live = typeof data.fullText === 'string' ? data.fullText : '';
  if (live.trim().length < MIN_RESTORE_CHARS) return { ok: true, reason: 'no live text' };
  if (parked.length < live.length * LONGER_RATIO) return { ok: false, reason: 'live text is not much shorter' };
  if (!deps.sameArticle(live, parked)) return { ok: false, reason: 'live text is a different article' };
  return { ok: true, reason: 'live text is a shorter copy of the same article' };
}

/**
 * Put the quarantined body back. Mutates `data`. wrongFullText stays as the
 * audit copy (it is write-guard protected, so a null would not stick anyway);
 * releasedBodyRestoredAt marks it as released, so readers such as
 * url-change-invariant's wouldDiscardScore do not take it as wrong-url
 * evidence (BRO-5261 S11). quarantineBody clears the stamp on the next
 * verdict. The tier is re-derived so the scorer and rebuild see the full text.
 */
function restoreReleasedBody(data, classifyContentTier, nowIso) {
  data.fullText = data.wrongFullText;
  // null, not delete: safeWriteReview's merge pass copies a missing key back from disk.
  data.quarantinedWordCount = null;
  data.releasedBodyRestoredAt = nowIso || new Date().toISOString();
  if (typeof classifyContentTier === 'function') {
    const tier = classifyContentTier(data);
    data.contentTier = tier.contentTier;
    data.contentTierReason = tier.tierReason;
    data.tierReason = tier.tierReason;
    data.wordCount = tier.wordCount;
    if (tier.contentTier === 'complete' && ['partial_text', 'wrong_content'].includes(data.incompleteReason)) {
      data.incompleteReason = null;
      data.incompleteDetail = null;
    }
  }
  return data;
}

module.exports = { countWords, quarantineBody, describeTextState, releasedBodyRestoreVerdict, restoreReleasedBody };
