'use strict';

/**
 * Fail-closed policy for tiers whose art is uploaded by people (BRO-6995).
 *
 * verifyImage fails OPEN: no API key, a download error or an API error all come
 * back as { match: true, confidence: 'low' }, and verifyAndCollect then logs
 * "VERIFIED (low)" and keeps the art. That is fine for tiers whose art is the
 * publisher's own (TodayTix, Playbill, IBDB). It is not fine for Mezzanine /
 * Theater Diary, where anyone can attach any file to a production: Rope's
 * record held The Lost Boys' poster under the filename "Rope st clements.jpg".
 * For those tiers an answer that is not a medium or high confidence match is
 * a refusal, and the fetch falls through to the next tier.
 *
 * Pure function (CLAUDE.md §15); test: unconfirmed-art-policy.test.mjs.
 */

/** Tier names (the verifyAndCollect tierName) whose art anyone can upload. */
const USER_UPLOADED_TIERS = new Set(['Mezzanine']);

const CONFIRMING = new Set(['medium', 'high']);

/**
 * @param {string} tierName
 * @param {{match?: boolean, confidence?: string}|null} result  verifyImage output
 * @returns {string|null} why the candidate must be refused, or null to carry on
 */
function unconfirmedArtReason(tierName, result) {
  if (!USER_UPLOADED_TIERS.has(tierName)) return null;
  if (!result || typeof result !== 'object') return 'no verifier answer';
  if (result.match === true && CONFIRMING.has(result.confidence)) return null;
  // A confident "no" is already rejected by the normal path; report it the same way.
  if (result.match === false && CONFIRMING.has(result.confidence)) return null;
  return `verifier answered ${result.match === true ? 'match' : 'no match'} at ${result.confidence || 'unknown'} confidence (user-uploaded art needs medium or high)`;
}

module.exports = { USER_UPLOADED_TIERS, unconfirmedArtReason };
