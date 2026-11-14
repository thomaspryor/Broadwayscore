/**
 * Shared predicate for "should we auto-fill criticName from outlet-registry.defaultCritic?"
 *
 * Pure function. No I/O. Single source of truth so all 4 consumers
 * (rebuild fill-in, rebuild fingerprint-swap, gather-time promotion, admin-ingest)
 * apply the same rule.
 *
 * The Recs / Celebrity Autobiography 2026-05-20 incident was caused by The Recs
 * having defaultCritic="Erin Muldoon" while bylines actually rotate (the review
 * was by Randall David Cook). Setting outlet-registry.outlets[id].multiAuthor=true
 * suppresses the auto-fill so the source byline (or "Unknown") wins.
 *
 * @param {{defaultCritic?: string, multiAuthor?: boolean} | null | undefined} outletEntry
 * @returns {boolean} true iff the caller should fill criticName from outletEntry.defaultCritic
 */
function shouldFillDefaultCritic(outletEntry) {
  if (!outletEntry) return false;
  if (!outletEntry.defaultCritic) return false;
  if (outletEntry.multiAuthor === true) return false;
  return true;
}

module.exports = { shouldFillDefaultCritic };
