/**
 * Order-independent canonical pick for a same-URL group of 2+ review files
 * (BRO-3402).
 *
 * The old fold (`winner = compare(winner, next)` across the group) inherited
 * the comparator's non-transitivity: chooseCanonical in
 * fix-circular-duplicate-pairs.js mixes byline attestation, score richness and
 * the near-misspelling rule, which can rank A>B, B>C, C>A. The fold's survivor
 * then depended on readdirSync order, and the loser gets duplicateOf (hidden
 * from the site), so a non-deterministic review disappeared.
 *
 * Here every unordered pair is compared exactly once, always with the
 * lexicographically smaller filename passed first, and the canonical is the
 * member that wins every one of its pairs. No such member (a preference
 * cycle) means there is no defensible winner: report it, collapse nothing.
 *
 * Pure: no fs. `compare(aName, bName)` returns { canonical, reason?, skip? }.
 * `reason` is the winner's first pairwise win (sorted pair order), for the
 * on-disk duplicateReason trail; a skip carries the skipping pair's reason.
 * Used by dedupe-same-url-bylines.js. (suppression-logic.js
 * chooseSameUrlCanonical keeps its sorted fold: deterministic, and it must
 * pick SOME winner for fully-unsuppressed groups.)
 *
 * @param {string[]} names
 * @param {(aName: string, bName: string) => {canonical?: string, reason?: string, skip?: boolean}} compare
 * @returns {{canonical: string|null, reason: string|null, skip: boolean, intransitive: boolean}}
 */
function pickGroupCanonical(names, compare) {
  const sorted = [...new Set(names)].sort();
  if (sorted.length === 0) return { canonical: null, reason: null, skip: false, intransitive: false };
  if (sorted.length === 1) return { canonical: sorted[0], reason: null, skip: false, intransitive: false };
  const wins = new Map(sorted.map((n) => [n, 0]));
  const firstWinReason = new Map();
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const r = compare(sorted[i], sorted[j]);
      // A skip verdict (both sides cross-market contaminated) means "leave
      // this pair suppressed": abort the whole group, as the fold did.
      // A verdict naming neither compared file is malformed: treat as skip.
      if (!r || r.skip || (r.canonical !== sorted[i] && r.canonical !== sorted[j])) {
        return { canonical: null, reason: (r && r.reason) || null, skip: true, intransitive: false };
      }
      wins.set(r.canonical, wins.get(r.canonical) + 1);
      if (!firstWinReason.has(r.canonical)) firstWinReason.set(r.canonical, r.reason || null);
    }
  }
  const winner = sorted.find((n) => wins.get(n) === sorted.length - 1) || null;
  return {
    canonical: winner,
    reason: winner ? firstWinReason.get(winner) : 'no-consistent-canonical: pairwise preferences form a cycle',
    skip: false,
    intransitive: winner === null,
  };
}

module.exports = { pickGroupCanonical };
