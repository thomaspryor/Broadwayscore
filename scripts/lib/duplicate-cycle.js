const { DUPLICATE_POINTER_FIELDS } = require('./canonical-duplicate-pointers');

/**
 * Shared duplicate-pointer cycle-walk, used by both the write-time guard
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
 *
 * duplicateTextOf blind spot (Notion #1750, 2026-08-17 — loves-labours-lost
 * times-uk--clive-davis): the walk originally followed `duplicateOf` only.
 * A corpus scan the same day found 386 mutual cycles, every one of the shape
 * A.duplicateOf=B + B.duplicateTextOf=A — none refusable at write time
 * because the walk went cold the moment it reached a node whose only pointer
 * was duplicateTextOf. Each node's outgoing edges now include EVERY field in
 * DUPLICATE_POINTER_FIELDS (canonical-duplicate-pointers.js) that's set, not
 * just the first — an earlier "first field present wins" version shipped
 * with a confirmed false negative on live data (the-lion-king-west-end-2021
 * timeout-london--ben-walters.json: duplicateOf and duplicateTextOf point at
 * DIFFERENT files, and the real cycle only exists through the second one,
 * which field-priority never visited). The walk is a standard white/gray/black
 * DFS — each node is fully explored at most once (marked 'done' with no
 * cycle found under it), so trying every edge stays O(V+E) rather than
 * exponential, safe to run on every review write.
 */

/** Every valid duplicate-pointer target on `data`, in DUPLICATE_POINTER_FIELDS order, deduped. */
function outgoingTargets(data) {
  if (!data) return [];
  const out = [];
  for (const field of DUPLICATE_POINTER_FIELDS) {
    const val = data[field];
    if (typeof val === 'string' && val.endsWith('.json') && !out.includes(val)) out.push(val);
  }
  return out;
}

/**
 * Walk the duplicate-pointer graph (duplicateOf, duplicateTextOf — see
 * DUPLICATE_POINTER_FIELDS) starting at `startBasename` looking for a cycle
 * reachable from it. Every node can have up to DUPLICATE_POINTER_FIELDS.length
 * outgoing edges; a cycle is any edge that lands back on a node still on the
 * current DFS stack. Bounded by maxHops (total edges traversed, not path
 * depth) — callers should pass the show dir's own file count (or similar)
 * since a cycle can't be longer than the number of files that could
 * participate in it.
 *
 * @param {string} startBasename
 * @param {(basename: string) => ({duplicateOf?: string, duplicateTextOf?: string}|null)} load
 * @param {number} maxHops
 * @returns {{cycleFound: boolean, chain: string[]}} on cycleFound, chain is
 *   the DFS stack from startBasename down to the cycle, with the closing
 *   (repeated) node appended. On no cycle, chain is just [startBasename] —
 *   the DFS explores a tree, not a single path, so there's no one chain to
 *   report when nothing is found.
 */
function findDuplicateOfCycle(startBasename, load, maxHops) {
  const state = new Map(); // basename -> 'stack' | 'done'
  const stack = []; // {name, edges, idx}
  const pushFrame = (name) => {
    state.set(name, 'stack');
    stack.push({ name, edges: outgoingTargets(load(name)), idx: 0 });
  };
  pushFrame(startBasename);
  let hopsUsed = 0;
  while (stack.length) {
    const frame = stack[stack.length - 1];
    if (frame.idx >= frame.edges.length) {
      state.set(frame.name, 'done');
      stack.pop();
      continue;
    }
    if (hopsUsed >= maxHops) break;
    const next = frame.edges[frame.idx++];
    hopsUsed++;
    const nextState = state.get(next);
    if (nextState === 'stack') {
      const chain = stack.map((f) => f.name);
      chain.push(next);
      return { cycleFound: true, chain };
    }
    if (nextState === 'done') continue;
    pushFrame(next);
  }
  return { cycleFound: false, chain: [startBasename] };
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

/**
 * The rebuild's N-cycle tiebreak for one file, shared by the duplicateOf gate
 * (duplicate-of-exclusion.js) and the duplicateTextOf branch of
 * rebuild-all-reviews.js so both pointer fields resolve a cycle the same way.
 * Before BRO-5907 only the duplicateOf gate walked the graph: a cycle entered
 * through duplicateTextOf-only nodes (A.duplicateTextOf=B, B=C, C=A) had every
 * member skipped as a plain duplicate, so the review vanished.
 * The walk reads siblings through `read`; the tiebreak sees `data` in memory
 * for `file` itself (the rebuild may have corrected it this pass).
 * @param {string} file basename
 * @param {object} data this file's in-memory record
 * @param {(basename: string) => object|null} read
 * @param {number} maxHops
 * @param {(text: string) => string} fingerprintFn
 * inCycle is false when `file` only points INTO a cycle (a tail): the
 * duplicateOf gate has always tiebroken tails with the cycle, but the
 * duplicateTextOf branch keeps treating a tail as a plain duplicate.
 * @returns {{cycleFound: boolean, inCycle: boolean, sameText: boolean, survivor: string|null, exclude: boolean}}
 */
function cycleTiebreakFor(file, data, read, maxHops, fingerprintFn) {
  const walk = findDuplicateOfCycle(file, read, maxHops);
  if (!walk.cycleFound) return { cycleFound: false, inCycle: false, sameText: false, survivor: null, exclude: false };
  const members = walk.chain.slice(0, -1);
  const closing = walk.chain[walk.chain.length - 1];
  const inCycle = walk.chain.indexOf(closing) === 0;
  const tie = resolveCycleTiebreak(members, name => (name === file ? data : read(name)), fingerprintFn);
  return { cycleFound: true, inCycle, sameText: tie.sameText, survivor: tie.survivor, exclude: tie.sameText && file !== tie.survivor };
}

module.exports = { findDuplicateOfCycle, wouldFormDuplicateCycle, resolveCycleTiebreak, cycleTiebreakFor };
