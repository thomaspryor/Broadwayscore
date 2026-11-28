/**
 * revival-chain.js — pure logic for assigning originalProductionId +
 * productionNumber across a group of same-title productions.
 *
 * originalProductionId must point to the chronologically EARLIEST production
 * of a title (engine.ts:86 doc comment). The bug this replaces picked
 * existingProductions[0] from whatever was ALREADY in shows.json at
 * discovery time, sorted ascending — correct only when productions are
 * discovered in chronological order. Discovering an older production AFTER
 * a newer one already exists (common — discover-historical-shows.js runs
 * per-season, not oldest-to-newest) silently pointed the older show's
 * originalProductionId at the newer one. Verified 173/214 existing
 * shows.json entries were backwards as of 2026-08-25.
 */

'use strict';

/**
 * @param {Array<{id: string, openingDate: string|null|undefined}>} productions
 *   All productions sharing a title group (any order, any subset).
 * @returns {Array<{id: string, originalProductionId: string|null, productionNumber: number}>}
 *   One entry per input production, chronologically assigned: the earliest
 *   gets originalProductionId=null + productionNumber=1; every other entry
 *   points at the earliest and is numbered by chronological position.
 *   Missing/null openingDate sorts last (unknown-date productions never
 *   displace a dated production as "the original").
 */
function assignRevivalChain(productions) {
  const sorted = [...productions].sort((a, b) => {
    const da = a.openingDate || '9999-99-99';
    const db = b.openingDate || '9999-99-99';
    if (da !== db) return da < db ? -1 : 1;
    return String(a.id).localeCompare(String(b.id)); // stable tiebreak
  });

  const earliestId = sorted[0].id;
  return sorted.map((p, i) => ({
    id: p.id,
    originalProductionId: p.id === earliestId ? null : earliestId,
    productionNumber: i + 1,
  }));
}

module.exports = { assignRevivalChain };
