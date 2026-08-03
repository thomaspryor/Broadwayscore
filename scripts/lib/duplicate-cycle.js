/**
 * Shared duplicateOf cycle-walk, used by both the write-time guard
 * (review-write-guard.js — would writing this edge COMPLETE a cycle?) and the
 * post-hoc audit + rebuild tiebreak (audit-duplicate-of-url-mismatch.js,
 * rebuild-all-reviews.js — does the corpus already CONTAIN one?).
 *
 * Both call sites used to carry their own 2-node-only assumption
 * (colliderData.duplicateOf === thisBasename) — real cycles can be longer
 * (Notion #941: washpost 3-cycle andor-brodeur -> justin-davidson ->
 * michael-andor-brodeur -> andor-brodeur, none of it caught until the audit's
 * N-hop walk was added). One walk, reused everywhere, means write-time
 * refusal and audit-time detection can never disagree about what counts as a
 * cycle.
 */

/**
 * Walk the duplicateOf chain starting at `startBasename` looking for a cycle.
 * Bounded by maxHops, not a fixed constant elsewhere — callers should pass
 * the show dir's own file count (or similar) since a cycle can't be longer
 * than the number of files that could participate in it.
 *
 * @param {string} startBasename
 * @param {(basename: string) => ({duplicateOf?: string}|null)} load
 * @param {number} maxHops
 * @returns {{cycleFound: boolean, chain: string[]}} chain includes every
 *   node visited; when cycleFound, the last entry duplicates an earlier one.
 */
function findDuplicateOfCycle(startBasename, load, maxHops) {
  const chain = [startBasename];
  const seen = new Set([startBasename]);
  const startData = load(startBasename);
  let cursor = startData && typeof startData.duplicateOf === 'string' && startData.duplicateOf.endsWith('.json')
    ? startData.duplicateOf
    : null;
  for (let hop = 0; hop < maxHops && cursor; hop++) {
    if (seen.has(cursor)) {
      chain.push(cursor);
      return { cycleFound: true, chain };
    }
    const cursorData = load(cursor);
    if (!cursorData || typeof cursorData.duplicateOf !== 'string' || !cursorData.duplicateOf.endsWith('.json')) break;
    chain.push(cursor);
    seen.add(cursor);
    cursor = cursorData.duplicateOf;
  }
  return { cycleFound: false, chain };
}

/**
 * Would setting `thisBasename`'s duplicateOf to `candidateTarget` complete a
 * duplicateOf cycle of any length? Simulates the edge by overriding
 * thisBasename's record in a virtual load, then re-runs findDuplicateOfCycle
 * — the same walk the post-hoc audit uses. Catches both the 2-node case
 * (candidateTarget already points back at thisBasename) and longer chains
 * (candidateTarget's existing chain eventually reaches thisBasename via one
 * or more intermediate sibling files).
 *
 * @param {string} thisBasename basename of the file being written
 * @param {string|null|undefined} candidateTarget the duplicateOf value about to be set
 * @param {(basename: string) => ({duplicateOf?: string}|null)} load loads a sibling's parsed record by basename
 * @param {number} [maxHops]
 * @returns {boolean}
 */
function wouldFormDuplicateCycle(thisBasename, candidateTarget, load, maxHops = 500) {
  if (!candidateTarget) return false;
  const virtualLoad = (name) => (name === thisBasename ? { duplicateOf: candidateTarget } : load(name));
  return findDuplicateOfCycle(thisBasename, virtualLoad, maxHops).cycleFound;
}

/**
 * Resolve rebuild-all-reviews.js's circular-duplicate tiebreak for a cycle of
 * ANY length: given the cycle's participants (as returned by
 * findDuplicateOfCycle — pass `chain.slice(0, -1)` to drop the loop-closing
 * repeat), decide whether they all share one content fingerprint, and if so,
 * which single member survives. Generalizes the pre-existing 2-node rule
 * ("only tiebreak on true duplicates — same content fingerprint; exclude the
 * lexicographically-greater filename") to an N-way set via the
 * lexicographically-SMALLEST basename as the deterministic survivor — every
 * cycle member's independent rebuild pass computes the same `members` array
 * and reaches the same answer, so exactly one member survives.
 *
 * @param {string[]} members cycle participants, each listed once
 * @param {(basename: string) => ({fullText?: string}|null)} load loads a member's parsed record by basename
 * @param {(text: string) => string} fingerprintFn content-fingerprint function (computeContentFingerprint from lib/content-quality.js)
 * @returns {{sameText: boolean, survivor: string|null}}
 */
function resolveCycleTiebreak(members, load, fingerprintFn) {
  if (!members || members.length === 0) return { sameText: false, survivor: null };
  const fingerprints = members.map((m) => {
    const d = load(m);
    return d && d.fullText ? fingerprintFn(d.fullText) : null;
  });
  const sameText = fingerprints.every((fp) => fp && fp === fingerprints[0]);
  const survivor = members.slice().sort()[0];
  return { sameText, survivor };
}

module.exports = { findDuplicateOfCycle, wouldFormDuplicateCycle, resolveCycleTiebreak };
