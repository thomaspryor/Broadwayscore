/**
 * page-bleed-repair.js — decide whether a freshly re-extracted article body may
 * replace a stored fullText that has other articles glued onto it (BRO-4977).
 *
 * The stored text came from an extractor that kept the page's auto-loaded
 * "next stories" (Times Square Chronicles: 66 of 102 reviews). The fixed
 * extractor now returns the body alone. A replacement is accepted only when it
 * is provably the SAME article, just without the tail:
 *   - the new text is a real body (>= 500 chars);
 *   - the stored text is meaningfully longer (>= 15%), so there is a tail;
 *   - the new text's opening and closing passages both occur in the stored
 *     text, opening near its start. Punctuation, quote style and whitespace
 *     are ignored, since the two came from different extractors;
 *   - when the caller names tail markers (the critic's name, the outlet's
 *     name), one opens the removed part: the author box that starts it.
 * Anything else (a rewritten article, a paywall stub, a different page) is
 * refused and the stored text stays. Pure, no I/O.
 */

'use strict';

const { foldDiacritics } = require('./title-match');

const RESCORE_REASON = 'page-bleed-trim (BRO-4977)';

// Fold before stripping: "Bernábe" must compare equal across extractors, not
// lose its letter (sibling-matchers-diacritics guard).
function norm(s) {
  return foldDiacritics(String(s || '')).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * @param {object} record   stored review-text record
 * @param {string} newText  body from the current extractor
 * @returns {{ok: true, previousLength: number} | {ok: false, reason: string}}
 */
function checkBleedTrim(record, newText, { tailMarkers = [] } = {}) {
  const oldText = (record && record.fullText) || '';
  if (!newText || newText.length < 500) return { ok: false, reason: 'new text under 500 chars' };
  if (oldText.length < newText.length * 1.15) return { ok: false, reason: 'stored text has no tail to trim' };
  const o = norm(oldText);
  const n = norm(newText);
  if (n.length < 300) return { ok: false, reason: 'new text too short once normalised' };
  // Opening: either text's first passage near the other's start (one extractor
  // keeps a photo caption the other drops).
  const headAt = o.indexOf(n.slice(0, 200));
  const headOk = (headAt >= 0 && headAt <= 2000)
    || (() => { const at = n.indexOf(o.slice(0, 200)); return at >= 0 && at <= 2000; })();
  if (!headOk) return { ok: false, reason: 'opening passage not at the start of the stored text' };
  // Closing: a passage from the end of the new body, in the stored text. The
  // very last line can differ (a short venue line one extractor skips), so
  // fall back to windows ending a little earlier, but never more than ~400
  // normalised chars (a line or two): a body cut off mid-review must not pass.
  let tailEnd = -1;
  for (const back of [0, 150, 300, 400]) {
    const end = n.length - back;
    const win = n.slice(Math.max(0, end - 200), end);
    const at = o.indexOf(win, Math.max(0, headAt));
    if (at >= 0) { tailEnd = at + win.length + (n.length - end); break; }
  }
  if (tailEnd < 0) return { ok: false, reason: 'closing passage not in the stored text' };
  if (o.length - tailEnd < o.length * 0.1) return { ok: false, reason: 'stored text does not continue past the body' };
  // What follows the body must look like page chrome, not more of the same
  // review: the site's author box (critic name, outlet name) opens the glued
  // part on every Zox page. Text alone cannot tell a body cut off early from
  // one with articles glued on, so this is what refuses the former.
  const markers = tailMarkers.map(norm).filter(m => m.length >= 3);
  if (markers.length && !markers.some(m => o.slice(tailEnd, tailEnd + 700).includes(m))) {
    return { ok: false, reason: 'text after the body does not open with the author box' };
  }
  return { ok: true, previousLength: oldText.length };
}

/**
 * Apply an accepted trim: new fullText, queue a rescore (the score and pull
 * quote were computed on the glued text), drop a pull quote that is no longer
 * in the review. Returns a new object; the input is not mutated.
 */
function applyBleedTrim(record, newText, { at, source } = {}) {
  const out = { ...record };
  const previousLength = (record.fullText || '').length;
  out.fullText = newText;
  const wc = newText.split(/\s+/).filter(Boolean).length;
  if ('textWordCount' in out) out.textWordCount = wc;
  if ('wordCount' in out) out.wordCount = wc;
  if (out.llmPullQuote && !norm(newText).includes(norm(out.llmPullQuote))) out.llmPullQuote = null;
  out.needsRescore = true;
  out.rescoreReason = RESCORE_REASON;
  out.rescoreFlaggedAt = at || new Date().toISOString();
  delete out.rescoreCompletedAt;
  out.pageBleedRepair = { at: out.rescoreFlaggedAt, previousLength, newLength: newText.length, source: source || null };
  return out;
}

module.exports = { checkBleedTrim, applyBleedTrim, RESCORE_REASON };
