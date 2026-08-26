/**
 * Reconcile the Notion-sourced stuck-work buckets against Linear.
 *
 * WHY (BRO-104, 2026-08-26): the three "Stuck work:" digest rows are computed
 * from the Notion brain (scripts/lib/stuck-work.js), but CLAUDE.md §6 moved the
 * board to Linear on 2026-08-12 — "Linear is the source of truth". Sessions now
 * close their work in Linear and never touch the Notion twin, so the Notion
 * card sits Paused/In-progress forever and the counts only ever grow. The
 * 2026-07-24 → 2026-08-26 "regression" (19→40 paused P0/P1, 34→55 orphaned,
 * 4→20 paused P2) is almost entirely this residue, not work getting stuck:
 * measured on the 2026-08-26 corpus, 35 of the 55 orphaned cards and 16 of the
 * 20 paused-P2 cards had a Linear twin already in Done/Canceled/Duplicate.
 *
 * The rule is deliberately CONSERVATIVE, because the Notion→Linear mirror froze
 * at task id 1285 (2026-08-20) and cards filed in Notion after that never got a
 * Linear twin at all:
 *
 *   - twin exists AND is closed (completed/canceled/duplicate) → drop it. The
 *     source of truth says this work is finished; the Notion card is residue.
 *   - twin exists and is still open                            → keep it. Real
 *     stuck work, tracked in both places.
 *   - NO twin at all                                           → keep it. Might
 *     be post-freeze Notion-only work; never silently disappear it.
 *
 * Matching is on the normalized title. Notion card names are the same free text
 * linear-brain.js files as the issue title, so exact-after-normalization is the
 * right bar — fuzzy matching here would drop live cards on a near-miss, which
 * is the one failure mode that actually loses work.
 *
 * `reconcileStuckBuckets` is pure (rule 15): health-check.js supplies the
 * Linear state map from `fetchLinearIssueStates`, tests supply a fixture.
 */

/** Linear state types that mean "this work is finished, stop counting it". */
const CLOSED_STATE_TYPES = new Set(['completed', 'canceled', 'duplicate']);

/**
 * Normalize a card name / issue title for cross-board matching.
 * Collapses whitespace and case; keeps punctuation, which carries meaning in
 * titles like "P0: ..." and is identical on both boards.
 * @param {string} s
 * @returns {string}
 */
function normalizeTitle(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Split one bucket into the cards that are still stuck and the ones Linear has
 * already closed.
 * @param {Array<{name:string}>} cards
 * @param {Map<string,string>} linearStateByTitle normalized title -> state type
 * @returns {{kept: Array, resolved: Array}}
 */
function partitionBucket(cards, linearStateByTitle) {
  const kept = [];
  const resolved = [];
  for (const card of cards || []) {
    const stateType = linearStateByTitle.get(normalizeTitle(card && card.name));
    if (stateType && CLOSED_STATE_TYPES.has(stateType)) resolved.push(card);
    else kept.push(card);
  }
  return { kept, resolved };
}

/**
 * Apply the reconcile to every stuck-work bucket.
 *
 * @param {{pausedCritical:Array, orphaned:Array, pausedStale:Array}} buckets
 * @param {Map<string,string>|null} linearStateByTitle normalized title -> Linear
 *   state type. Pass null/empty to disable (returns the buckets untouched) —
 *   an unreachable Linear must never shrink the counts.
 * @returns {{pausedCritical:Array, orphaned:Array, pausedStale:Array,
 *            resolvedCounts:{pausedCritical:number,orphaned:number,pausedStale:number,total:number},
 *            applied:boolean}}
 */
function reconcileStuckBuckets(buckets, linearStateByTitle) {
  const empty = { pausedCritical: 0, orphaned: 0, pausedStale: 0, total: 0 };
  // No map, or a map we failed to populate: leave the counts alone. Shrinking
  // a stuck-work row because an API call failed would be the worst outcome
  // here — it hides real stuck work behind a green-looking number.
  if (!linearStateByTitle || linearStateByTitle.size === 0) {
    return {
      pausedCritical: buckets.pausedCritical || [],
      orphaned: buckets.orphaned || [],
      pausedStale: buckets.pausedStale || [],
      resolvedCounts: empty,
      applied: false,
    };
  }

  const pc = partitionBucket(buckets.pausedCritical, linearStateByTitle);
  const or = partitionBucket(buckets.orphaned, linearStateByTitle);
  const ps = partitionBucket(buckets.pausedStale, linearStateByTitle);

  return {
    pausedCritical: pc.kept,
    orphaned: or.kept,
    pausedStale: ps.kept,
    resolvedCounts: {
      pausedCritical: pc.resolved.length,
      orphaned: or.resolved.length,
      pausedStale: ps.resolved.length,
      total: pc.resolved.length + or.resolved.length + ps.resolved.length,
    },
    applied: true,
  };
}

/**
 * Fetch every Linear issue title (INCLUDING archived — Done issues get archived,
 * and an archived Done twin is the strongest possible "not stuck" signal) mapped
 * to its state type.
 *
 * Returns an EMPTY map on any failure so `reconcileStuckBuckets` degrades to a
 * no-op rather than under-reporting. Never throws: this runs inside the digest,
 * where an uncaught rejection takes out every downstream row.
 *
 * @param {{graphql:Function, getTeam:Function}} [client] injectable for tests
 * @returns {Promise<Map<string,string>>}
 */
async function fetchLinearIssueStates(client) {
  const map = new Map();
  try {
    const lc = client || require('./linear-client.js');
    const team = await lc.getTeam();
    if (!team || !team.id) return map;
    let after = null;
    // ~2.4k issues today; 250/page, capped so a pagination bug can't spin.
    for (let page = 0; page < 40; page++) {
      const data = await lc.graphql(
        `query($teamId: String!, $after: String) {
          team(id: $teamId) {
            issues(first: 250, after: $after, includeArchived: true) {
              nodes { title state { type } }
              pageInfo { hasNextPage endCursor }
            }
          }
        }`,
        { teamId: team.id, after }
      );
      const conn = data && data.team && data.team.issues;
      if (!conn) break;
      for (const n of conn.nodes || []) {
        if (n && n.title && n.state && n.state.type) {
          map.set(normalizeTitle(n.title), n.state.type);
        }
      }
      if (!conn.pageInfo || !conn.pageInfo.hasNextPage) break;
      after = conn.pageInfo.endCursor;
    }
  } catch {
    // Degrade to "no reconcile" — see the contract above.
    return new Map();
  }
  return map;
}

module.exports = {
  CLOSED_STATE_TYPES,
  normalizeTitle,
  partitionBucket,
  reconcileStuckBuckets,
  fetchLinearIssueStates,
};
