'use strict';

/**
 * verify-existing-reviews.js RECOVER-mode selection, extracted so tests
 * require() the real decision (CLAUDE.md §15). Recovery clears wrongShow and
 * wrongProduction, so a held approval on either keeps the file out (BRO-7174).
 */

const { canRecoverReview } = require('./approved-fix-writer-guards');
const { OTHER_PRODUCTION_URL_REASON } = require('./other-production-signal');

const MIN_RECOVER_TEXT = 200;

/** @returns {{text: string, textSource: string} | null} */
function recoverCandidate(r) {
  if (!r || !(r.wrongProduction || r.wrongShow)) return null;
  if (!canRecoverReview(r)) return null;
  // Skip wrongAttribution: those are typically correct.
  if (r.wrongAttribution) return null;
  // url-proven (BRO-5015): no LLM read can clear it, so don't pay for one.
  if (r.wrongProductionReason === OTHER_PRODUCTION_URL_REASON) return null;
  const text = r.fullText || r.wrongFullText || r.garbageFullText;
  if (!text || text.length < MIN_RECOVER_TEXT) return null;
  return { text, textSource: r.fullText ? 'fullText' : r.wrongFullText ? 'wrongFullText' : 'garbageFullText' };
}

module.exports = { recoverCandidate, MIN_RECOVER_TEXT };
