/**
 * Baseline-diff logic for audit-duplicate-shows.js (task #1675).
 *
 * Mirrors scripts/lib/outlet-registry-baseline.js (task #1666): a plain Set
 * is sufficient here, not a multiset/occurrence-count Map like
 * broadway-category-predicate-baseline.js needed — because a given
 * (showId, showId) pair reaches the baseline diff at most once per scan, so
 * there is no per-key duplicate-collapse hazard for a plain Set to hide behind.
 *
 * That used to be free: each detection pass visited any given show pair at most
 * once (the title+year grouping loop runs i < j over group members, and
 * findTitleFragmentDupes likewise), and no pass could reach a pair another pass
 * could. The THIRD pass broke the second half of that — the ticketing-identity
 * pass reaches exactly the shape the title+year pass is best at, so both can
 * emit one pair. The invariant is now ENFORCED rather than assumed, by
 * dedupeClustersByPair() below, which audit-duplicate-shows.js runs over the
 * combined clusters before either the baseline write or the baseline diff.
 * If you add a fourth pass, you need no new bookkeeping — but do not remove
 * that call.
 *
 * Identity is the unordered pair of show ids, not the cluster `key` (which
 * is a normalized-title+year string or a title-fragment venue string) and
 * not the `reason` — a cluster's title-grouping key can shift if a show's
 * title/venue is edited without the underlying pair being a "new" finding,
 * and a pair's reason can flip between runs (e.g. incomplete-stub becoming
 * shared-venue-token once a stub gets its venue backfilled) without it
 * becoming a genuinely new duplicate claim. Freezing on (a.id, b.id) is what
 * actually matters: the same two shows already adjudicated as "not a real
 * dupe" (or "known dupe, not yet merged") stay frozen regardless of which
 * detection branch or grouping key produced them this run.
 *
 * Pure functions only — no fs — so both the CLI and the test require() the
 * same logic (CLAUDE.md rule 15).
 */
'use strict';

// Unordered-pair identity: sort so (a, b) and (b, a) collide to the same key.
function pairKey(aId, bId) {
  return [aId, bId].sort().join('|');
}

// baselinePairs: array of { a, b } show-id pairs as stored in the baseline
// JSON's `pairs` array. Returns a Set for O(1) membership checks.
function baselineKeySet(baselinePairs) {
  return new Set((baselinePairs || []).map((p) => pairKey(p.a, p.b)));
}

// clusters: array of { key, pairs: [{ a: {id, ...}, b: {id, ...}, reason }, ...] }
// as produced by audit-duplicate-shows.js's main(). baselineSet: Set from
// baselineKeySet(). Returns the same shape, filtered down to only pairs whose
// (a.id, b.id) identity is NOT in the baseline — clusters left with zero
// pairs are dropped entirely.
function computeNewViolators(clusters, baselineSet) {
  return (clusters || [])
    .map((c) => ({
      key: c.key,
      pairs: (c.pairs || []).filter((p) => !baselineSet.has(pairKey(p.a.id, p.b.id))),
    }))
    .filter((c) => c.pairs.length > 0);
}

// Collapse clusters so each unordered show-id pair is reported at most ONCE
// across every detection pass, keeping the FIRST occurrence.
//
// The Set-not-multiset choice documented at the top of this file rests on "a
// given (showId, showId) pair can appear at most once per scan". That was true
// only while each pass could reach pairs the others could not. The ticketing-
// identity pass (scripts/lib/show-duplicate-detection.js) reaches exactly the
// shape the title+year pass is best at — two same-titled entries at one venue
// that also share a ticket listing — so both would emit it. The two older
// passes can collide as well: normalizeTitle strips subtitles, so a raw-token
// title-fragment pair can share a normalized title and land in the same group.
//
// A double emission never flips a --strict verdict, since the baseline filter
// drops both copies alike. It DOES inflate the reported pair counts and make
// --update-baseline write the same pair into the baseline JSON twice, which is
// why this runs before both the baseline write and the baseline diff.
function dedupeClustersByPair(clusters) {
  const seen = new Set();
  const out = [];
  for (const c of clusters || []) {
    const pairs = (c.pairs || []).filter((p) => {
      const k = pairKey(p.a.id, p.b.id);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    if (pairs.length) out.push({ ...c, pairs });
  }
  return out;
}

module.exports = { pairKey, baselineKeySet, computeNewViolators, dedupeClustersByPair };
