/**
 * autonomous-shadow-slice.js — pure slice selection for the attempt-memory
 * shadow run (scripts/autonomous-shadow-run.js).
 *
 * Card #669: notion-brain's `list` sorts Priority-ascending, and
 * Marketing/Partnerships cards happen to sort near the top of the
 * "Not started" pool. Picking the first `limit` ids off that list therefore
 * hands the shadow run the SAME human-territory cards every night — they
 * never reach triageCard()'s decision stage, so the shadow proof produces
 * zero real-card evidence no matter how many nights it runs.
 *
 * selectShadowSlice() fixes this deterministically (no LLM, no Notion write):
 * given an OVER-FETCHED candidate pool (the caller fetches more ids than
 * `limit` so there's room to walk past pre-filtered cards), it returns the
 * first `limit` cards that would actually reach the decision stage, plus
 * every card it passed over and why — so a slice night can never silently
 * report "N skipped" without saying which N or the reason.
 */

'use strict';

/**
 * @param {object} opts
 * @param {Array<object>} opts.cards - candidate pool, in priority order (or
 *   whatever order the caller wants walked first).
 * @param {number} opts.limit - max cards to select. Must be a positive integer.
 * @param {(card: object) => (string|null|undefined|false)} [opts.isHumanTerritory] -
 *   predicate returning a truthy skip-reason string when the card would never
 *   reach triageCard's decision stage (human-territory category, deny-tagged,
 *   already claimed, etc.), or a falsy value when it's a real candidate.
 *   Omitted = every card is a candidate.
 * @param {Set<string>} [opts.alreadySeenIds] - card ids to skip regardless of
 *   isHumanTerritory (e.g. cards a prior slice already covered this run).
 * @returns {{selected: object[], skipped: {card: object, reason: string}[]}}
 */
function selectShadowSlice({ cards, limit, isHumanTerritory, alreadySeenIds } = {}) {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`selectShadowSlice: limit must be a positive integer, got ${JSON.stringify(limit)}`);
  }
  const seen = alreadySeenIds || new Set();
  const selected = [];
  const skipped = [];
  for (const card of cards || []) {
    if (selected.length >= limit) break;
    if (seen.has(card.id)) {
      skipped.push({ card, reason: 'already-seen' });
      continue;
    }
    const reason = isHumanTerritory ? isHumanTerritory(card) : null;
    if (reason) {
      skipped.push({ card, reason });
      continue;
    }
    selected.push(card);
  }
  return { selected, skipped };
}

module.exports = { selectShadowSlice };
