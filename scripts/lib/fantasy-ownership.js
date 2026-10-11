'use strict';
/**
 * Fantasy League "most picked" percentages (BRO-4338, owner decision 2026-10-11).
 *
 * Pure: takes entries ({ picks: string[] }) and returns, per show, how many
 * rosters include it and that share of all rosters. Used by
 * /api/fantasy/ownership (src/app/api/fantasy/ownership/route.ts).
 *
 * Privacy floor: below MIN_ENTRIES_TO_PUBLISH rosters nothing is published, so
 * a percentage can never point at one or two identifiable players.
 */

const MIN_ENTRIES_TO_PUBLISH = 10;

/**
 * @param {Array<{ picks?: unknown }>} entries
 * @param {{ minEntries?: number }} [opts]
 * @returns {{ totalEntries: number, published: boolean, shows: Record<string, { count: number, pct: number }> }}
 */
function computePickOwnership(entries, { minEntries = MIN_ENTRIES_TO_PUBLISH } = {}) {
  const rosters = (Array.isArray(entries) ? entries : []).filter((e) => e && Array.isArray(e.picks));
  const totalEntries = rosters.length;
  if (totalEntries < minEntries) return { totalEntries, published: false, shows: {} };

  const counts = new Map();
  for (const e of rosters) {
    // A malformed roster listing a show twice still counts once.
    for (const id of new Set(e.picks.filter((p) => typeof p === 'string' && p))) {
      counts.set(id, (counts.get(id) || 0) + 1);
    }
  }
  const shows = {};
  for (const [id, count] of counts) {
    shows[id] = { count, pct: Math.round((count / totalEntries) * 100) };
  }
  return { totalEntries, published: true, shows };
}

/** "<1%" for a show someone picked that rounds to zero; otherwise "N%". */
function formatOwnershipPct(pct) {
  return pct < 1 ? '<1%' : `${pct}%`;
}

module.exports = { computePickOwnership, formatOwnershipPct, MIN_ENTRIES_TO_PUBLISH };
