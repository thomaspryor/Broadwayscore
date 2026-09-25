/**
 * show-not-mentioned-autoclear.js — the rebuild's "stale showNotMentioned"
 * safety net (rebuild-all-reviews.js), extracted so it is testable and so it
 * uses the SAME validators the collectors use instead of a bare substring.
 *
 * History: the rebuild used to clear showNotMentioned (and restore
 * wrongFullText → fullText) whenever the show title appeared ONCE as a
 * substring (first 5000 chars; widened to 60K chars + punctuation-insensitive
 * variants on 2026-09-24). A single passing mention — a roundup, a "see also"
 * sidebar, a different show's review that name-drops this one — was enough,
 * bypassing the multi-mention url_content_mismatch check
 * (content-quality.js validateContentMentionsShow). Adversarial review
 * 2026-09-24 (P1-d): gate on the collection validators, and record reversible
 * provenance on the write.
 *
 * Gate (ALL must hold):
 *   - validateShowMentioned(text, title, id).valid   (collect-review-texts.js heuristic)
 *   - validateContentMentionsShow(text, null, title, id).valid
 *     (post-fetch sanity check: length-scaled mention count — ≥3 for ≥1500
 *     chars — with the punctuation-insensitive title variants)
 *   - if that validator only passed via its long-title discount (count below
 *     the length-scaled threshold), the title must appear in the lede
 *
 * Pure — no I/O.
 */

const { validateShowMentioned, validateContentMentionsShow } = require('./content-quality');
const { textMentionsTitle } = require('./show-title-variants');

const TEXT_CAP = 60000;
const LEDE_CHARS = 600;
const CLEARED_BY = 'rebuild-all-reviews:show-mention-autoclear';

/** Text the safety net inspects: fullText, else wrongFullText (collectors move
 * fullText → wrongFullText when they set showNotMentioned). */
function pickTextToCheck(data) {
  if (data && typeof data.fullText === 'string' && data.fullText.length > 300) return { field: 'fullText', text: data.fullText };
  if (data && typeof data.wrongFullText === 'string' && data.wrongFullText.length > 300) return { field: 'wrongFullText', text: data.wrongFullText };
  return { field: null, text: null };
}

/**
 * @param {object} data       - parsed review JSON (showNotMentioned === true expected)
 * @param {object} ctx
 * @param {string} ctx.showTitle - shows.json title (or ID-derived fallback)
 * @param {string} ctx.showId
 * @returns {{clear:boolean, field:string|null, reason:string, mentionCount?:number, threshold?:number}}
 */
/**
 * Stored-text show-mention gate (no HTML available): the collection
 * validators, minus the long-title discount unless the title is in the lede.
 * Shared by the rebuild auto-clear and incomplete-reason's stale
 * url_content_mismatch check.
 *
 * @returns {{pass:boolean, reason:string, mentionCount?:number, threshold?:number}}
 */
function passesStoredTextMentionGate(text, showTitle, showId) {
  if (!text || typeof text !== 'string') return { pass: false, reason: 'no-text' };
  if (!showTitle && !showId) return { pass: false, reason: 'no-title' };
  const capped = text.substring(0, TEXT_CAP);
  const heuristic = validateShowMentioned(capped, showTitle, showId);
  if (!heuristic.valid) return { pass: false, reason: `heuristic: ${heuristic.reason}` };
  const sanity = validateContentMentionsShow(capped, null, showTitle, showId);
  const counts = { mentionCount: sanity.mentionCount, threshold: sanity.threshold };
  if (!sanity.valid) return { pass: false, reason: `mention-count: ${sanity.reason}`, ...counts };
  // validateContentMentionsShow drops the threshold to 1 for a long (4+ word)
  // title phrase found ANYWHERE in the body — a discount meant for fetches
  // whose <title> proves the page. There is no <title> here, so a single
  // long-title mention only counts when it sits in the headline/lede (first
  // LEDE_CHARS); otherwise the undiscounted length-scaled count must hold. A
  // "see also: <show>" sidebar at the end of a different review must not pass.
  if (sanity.mentionCount < sanity.threshold && !textMentionsTitle(capped.substring(0, LEDE_CHARS), showTitle)) {
    return { pass: false, reason: `mention-count: ${sanity.mentionCount} < ${sanity.threshold} and no lede mention`, ...counts };
  }
  return { pass: true, reason: heuristic.reason, ...counts };
}

function decideShowNotMentionedAutoClear(data, { showTitle, showId } = {}) {
  if (!data || data.showNotMentioned !== true) return { clear: false, field: null, reason: 'not-flagged' };
  const { field, text } = pickTextToCheck(data);
  if (!text) return { clear: false, field: null, reason: 'no-text' };
  const gate = passesStoredTextMentionGate(text, showTitle, showId);
  return { clear: gate.pass, field, reason: gate.reason, mentionCount: gate.mentionCount, threshold: gate.threshold };
}

/**
 * Apply a clear decision to a review object (pure — returns a new object),
 * recording reversible provenance: when/by whom, the evidence, and the prior
 * flag state (including whether fullText was restored from wrongFullText, so
 * a revert knows to move it back).
 */
function applyShowNotMentionedClear(source, decision, nowIso) {
  const out = { ...source };
  const prior = { showNotMentioned: source.showNotMentioned === true };
  if (source._showNotMentionedDiscoveryAttempted !== undefined) {
    prior._showNotMentionedDiscoveryAttempted = source._showNotMentionedDiscoveryAttempted;
  }
  out.showNotMentioned = false;
  delete out._showNotMentionedDiscoveryAttempted;
  let restored = false;
  if (!out.fullText && out.wrongFullText) {
    out.fullText = out.wrongFullText;
    delete out.wrongFullText;
    restored = true;
  }
  prior.restoredFullTextFromWrongFullText = restored;
  out.showNotMentionedClearedAt = nowIso;
  out.showNotMentionedClearedBy = CLEARED_BY;
  out.showNotMentionedClearedEvidence = {
    reason: decision && decision.reason,
    mentionCount: decision && decision.mentionCount,
    threshold: decision && decision.threshold,
  };
  out.showNotMentionedClearedPrior = prior;
  return out;
}

module.exports = {
  decideShowNotMentionedAutoClear,
  applyShowNotMentionedClear,
  passesStoredTextMentionGate,
  pickTextToCheck,
  CLEARED_BY,
  TEXT_CAP,
};
