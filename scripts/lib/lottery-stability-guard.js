// Pure decision function for scrape-lottery-rush.js's show-ID stability guard.
// Tested by tests/unit/lottery-stability-guard.test.mjs.
//
// The guard aborts a lottery/rush write when too many show IDs appear or vanish
// between the pre-scrape snapshot and the merged result — the signature of a
// source returning garbage (e.g. BwayRush 404s and the parse yields nothing).
//
// CRITICAL: deliberate lifecycle removals from cleanClosedShows() (changes with
// type 'removed-closed' / 'removed-orphan') are NOT volatility — they're shows
// that genuinely closed or fell out of shows.json. They must be excluded from
// the removal count, or a normal week of 4+ closures permanently wedges the
// workflow (5 closed West End shows aborted it every run 2026-06-22 → 06-28).

const MAX_ADDED = 5;
const MAX_REMOVED = 3;

function evaluateShowIdStability(original, updated, changes = []) {
  const intentionalRemovals = new Set(
    (changes || [])
      .filter(c => c && (c.type === 'removed-closed' || c.type === 'removed-orphan'))
      .map(c => c.showId)
  );

  const oldIds = new Set(Object.keys((original && original.shows) || {}));
  const newIds = new Set(Object.keys((updated && updated.shows) || {}));

  const added = [...newIds].filter(id => !oldIds.has(id));
  const removed = [...oldIds].filter(id => !newIds.has(id) && !intentionalRemovals.has(id));

  return {
    added,
    removed,
    abort: added.length > MAX_ADDED || removed.length > MAX_REMOVED,
  };
}

module.exports = { evaluateShowIdStability, MAX_ADDED, MAX_REMOVED };
