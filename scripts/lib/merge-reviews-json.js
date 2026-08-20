'use strict';

// Array-of-reviews merge for data/reviews.json (BRO-76 follow-up, card #1834).
//
// Why this exists: reviews.json is the hottest multi-writer core-data file
// (20+ independently-scheduled workflows — rebuild-reviews, llm-ensemble-
// score, enrich-reviews-${run_id} x4/day, etc.), registered `status:
// 'deferred'` in core-data-merge-registry.js at BRO-76 time specifically
// because it is ALSO the central scoring-pipeline file (CLAUDE.md §3/§12) —
// a wrong array-union merge risks silent scoring corruption across the whole
// site, not just one file.
//
// scripts/rebuild-all-reviews.js is the primary writer of reviews.json — it
// fully REGENERATES the reviews array from whatever review-texts corpus is
// on disk at that moment, and every other script/workflow that touches a
// review only edits an individual data/review-texts/{showId}/*.json file
// and then triggers a rebuild. There is one deliberate exception:
// manual-review-direct.js edits reviews.json directly (clones the private
// core-data repo, patches or appends one record, commits, `git push origin
// main`) — bypassing push-core-data/action.yml entirely, so it gets neither
// this reconciliation nor action.yml's retry loop on ITS OWN push. It still
// interacts with this merge whenever a push-core-data job's rebase lands on
// top of (or gets rebased against) whatever manual-review-direct.js last
// committed — at that point this merge sees it as an ordinary `remote` (or
// `ours`) snapshot like any other. Notably it never stamps `_meta.lastUpdated`
// (verified: grep of the script, 2026-08-20), which is why manualEntry
// priority below is checked BEFORE the snapshot-recency signal — a manual
// correction sitting under a stale timestamp must never lose to a routine
// rebuild just because the rebuild's _meta looks newer.
//
// Note on "wrongProduction/isNonReview" flag preservation (BRO-76 follow-up
// card language): those flags live on data/review-texts/{showId}/*.json
// files and gate EXCLUSION from reviews.json upstream, inside
// rebuild-all-reviews.js's per-file loop — a flagged review never reaches
// this array, so there is no such field on a reviews.json record to
// preserve here (verified: grep of the field-name set across the full
// 19.9k-review corpus, 2026-08-20). The actual manual-correction signal
// THIS file carries is `manualEntry: true` (manual-review-direct.js /
// scripts/lib/manual-entry-merge.js) — a human correction written straight
// into reviews.json, which rebuild-all-reviews.js's own merge pass already
// re-preserves every single run precisely because the pipeline would
// otherwise regenerate over it. This merge gives it the same priority: a
// manualEntry review always wins a same-key conflict against a non-manual
// twin.
//
// Merge rules:
//   * shape: { _meta, reviews: [...] }
//   * identity: showId + outlet(lower/trim) + criticKey(criticName) — reuses
//     manual-entry-merge.js's criticKey() (punctuation/diacritic-insensitive)
//     rather than a plain lower/trim key (rebuild's own pass-2 dedup key),
//     because manual-entry-merge.js exists specifically to bridge byline
//     text drift between a human correction and the pipeline's scrape
//     ("R. Scott Reedy" vs "R Scott Reedy", confirmed live on
//     wonder-regional-2026) — a weaker key would treat both sides of exactly
//     that conflict as disjoint and union them into a visible duplicate-
//     critic scoring input instead of resolving the conflict. Verified
//     collision-free across the full production corpus (19,903 reviews).
//   * manual-entry URL rescue (separate, narrower pass, run AFTER the
//     primary-key merge below): a manualEntry review can also disagree with
//     its pipeline twin by an outright byline SWAP, not just formatting
//     drift (confirmed live on iceboy-regional-2026 — "Chris Jones" vs
//     "Christopher Borrelli" on the same Chicago Tribune URL), which the
//     primary key alone cannot catch. manual-entry-merge.js's fallback for
//     this is a same-showId+URL match — but that fallback is NOT safe to
//     apply as a blanket identity rule the way the primary key is: the live
//     corpus has 7 legitimate same-show, same-URL, DIFFERENT-critic pairs
//     with no manualEntry involved at all (e.g. anastasia-2017's WSJ review
//     carries both Charles Isherwood and Edward Rothstein under the same
//     URL — co-bylined or corpus artifact, but genuinely two distinct
//     records, not a duplicate to collapse). So the URL match is scoped
//     narrowly: only rescues a pair where at least one side is
//     `manualEntry: true`, applied once over the already-merged output
//     (see the pass below) rather than during identity matching itself.
//   * disjoint identities (present on only one side): union — both sides'
//     additions survive. Safe by the same reasoning as mergeDiaryShows:
//     every writer only adds/updates review-texts files (or, for
//     manual-review-direct.js, a single record) and reruns a full rebuild;
//     nothing here deletes a review-texts file mid-race, so an identity
//     missing from one side is virtually always that side's rebuild
//     predating the other writer's newly-collected review, not an
//     intentional drop.
//     KNOWN LIMITATION (mirrors mergeDiaryShows' field-update limitation):
//     if a review was excluded from ours' rebuild by a flag applied to its
//     review-texts file moments before this run (wrongProduction, etc.), or
//     its review-texts file was deleted outright (e.g.
//     scripts/delete-stub-candidates.js), while remote's older snapshot
//     still carries the pre-exclusion entry, the union could resurrect it.
//     reviews.json carries no flag/tombstone data itself to detect this from
//     the snapshot alone, and this reconciler's private-core-data checkout
//     does not carry review-texts (a separate private repo) to cross-check
//     against — there is no cheap, safe way to close this from inside this
//     merge without also risking dropping a legitimate concurrent addition.
//     NOT strictly bounded to "one push cycle": if the excluding side keeps
//     losing pushes to an older snapshot, the resurrection can recur each
//     time until an uncontended rebuild finally lands. It IS bounded by
//     "eventually corrected by the next rebuild that isn't racing," and is
//     STRICTLY SAFER than the pre-existing status quo this replaces
//     (unconditional `-X ours`), which had no bound at all: it could
//     permanently drop either side's genuine additions depending purely on
//     which push won the race.
//   * same-identity conflict, in order:
//       1. manualEntry wins over non-manual (both manual → keep ours,
//          deterministic, matches the rebase's own `-X ours` default).
//       2. Otherwise, whichever whole SNAPSHOT's `_meta.lastUpdated` is
//          newer wins its version of the record. This is a full-rebuild
//          file: `_meta.lastUpdated` is stamped fresh by rebuild-all-
//          reviews.js on every run and reflects "as of this timestamp, this
//          is the complete, current state of every field for every review,
//          derived from the review-texts corpus at that moment" — a
//          causally meaningful signal for which SIDE more recently observed
//          the shared record (rescored, requoted, retiered, …), unlike a
//          per-field heuristic (contentTier, publishDate) that has no
//          relationship to which side's assignedScore is fresher.
//       3. Timestamps tied or unparseable on either side (rare — e.g. a
//          first-ever write, or a manual-vs-manual tie already resolved
//          above) → fall back to higher contentTier rank (complete >
//          truncated > excerpt > stub > invalid > untiered); else ours.
//   * _meta: newer lastUpdated wins (whole object, so its stats travel
//     together); totalReviews is corrected afterward to the actual merged
//     count, since the two sides' totalReviews almost never equals the
//     union's length.

const { canonicalizeUrlForDedup } = require('./review-guards');
const { criticKey } = require('./manual-entry-merge');

const TIER_RANK = { complete: 5, truncated: 4, excerpt: 3, stub: 2, invalid: 1 };

function tierRank(review) {
  return TIER_RANK[review && review.contentTier] || 0;
}

function keyOf(review) {
  if (!review || typeof review !== 'object' || !review.showId) return null;
  const outlet = String(review.outlet || 'unknown').toLowerCase().trim();
  return `${review.showId}|${outlet}|${criticKey(review.criticName)}`;
}

/** showId + canonicalized-URL identity — the fallback match manual-entry-merge.js
 * uses when the primary (outlet+critic) key disagrees across a byline swap. */
function urlKeyOf(review) {
  if (!review || typeof review !== 'object' || !review.showId || !review.url) return null;
  try {
    const canonical = canonicalizeUrlForDedup(review.url);
    return canonical ? `${review.showId}|url:${canonical}` : null;
  } catch {
    return null;
  }
}

function newerIso(a, b) {
  const ta = typeof a === 'string' ? Date.parse(a) : NaN;
  const tb = typeof b === 'string' ? Date.parse(b) : NaN;
  if (Number.isNaN(ta)) return b;
  if (Number.isNaN(tb)) return a;
  return tb > ta ? b : a;
}

/** Which whole snapshot's _meta.lastUpdated is newer: true (ours), false
 * (remote), or null (tied / unparseable on either side). */
function snapshotIsNewer(ours, remote) {
  const ta = Date.parse((ours && ours._meta && ours._meta.lastUpdated) || '');
  const tb = Date.parse((remote && remote._meta && remote._meta.lastUpdated) || '');
  if (Number.isNaN(ta) || Number.isNaN(tb) || ta === tb) return null;
  return ta > tb;
}

/** Resolve a same-identity conflict. Returns 'ours' | 'remote'.
 * @param {boolean|null} oursSnapshotNewer precomputed snapshotIsNewer(ours, remote) result */
function resolveConflict(ours, remote, oursSnapshotNewer = null) {
  const oursManual = ours.manualEntry === true;
  const remoteManual = remote.manualEntry === true;
  if (oursManual !== remoteManual) return oursManual ? 'ours' : 'remote';
  if (oursManual && remoteManual) return 'ours';

  if (oursSnapshotNewer === true) return 'ours';
  if (oursSnapshotNewer === false) return 'remote';

  const oursTier = tierRank(ours);
  const remoteTier = tierRank(remote);
  if (oursTier !== remoteTier) return oursTier > remoteTier ? 'ours' : 'remote';

  return 'ours';
}

function mergeReviewsJson(ours, remote) {
  ours = ours && typeof ours === 'object' ? ours : { reviews: [] };
  remote = remote && typeof remote === 'object' ? remote : { reviews: [] };
  const oursReviews = Array.isArray(ours.reviews) ? ours.reviews : [];
  const remoteReviews = Array.isArray(remote.reviews) ? remote.reviews : [];

  // First occurrence per PRIMARY key wins; a later remote review claiming a
  // key already seen is a duplicate WITHIN the remote snapshot itself and is
  // dropped outright (counted below). Deliberately primary-key-only, not
  // URL-based — see the manual-entry URL rescue note in the module comment
  // for why a same-URL rule can't safely apply here unscoped.
  const remoteByKey = new Map();
  const remoteCanonical = new Set();
  let remoteDuplicateKeysSkipped = 0;
  for (const r of remoteReviews) {
    const k = keyOf(r);
    if (k && remoteByKey.has(k)) {
      remoteDuplicateKeysSkipped++;
      continue;
    }
    if (k) remoteByKey.set(k, r);
    remoteCanonical.add(r);
  }

  const oursSnapshotNewer = snapshotIsNewer(ours, remote);
  const consumedRemote = new Set();
  const mergedReviews = [];
  let conflicts = 0;
  let conflictsResolvedToRemote = 0;

  for (const r of oursReviews) {
    const k = keyOf(r);
    const remoteMatch = k ? remoteByKey.get(k) : null;
    if (!remoteMatch) {
      mergedReviews.push(r);
      continue;
    }
    consumedRemote.add(remoteMatch);
    conflicts++;
    if (resolveConflict(r, remoteMatch, oursSnapshotNewer) === 'remote') {
      mergedReviews.push(remoteMatch);
      conflictsResolvedToRemote++;
    } else {
      mergedReviews.push(r);
    }
  }

  let added = 0;
  for (const r of remoteReviews) {
    if (!remoteCanonical.has(r)) continue; // dropped duplicate-within-remote (counted above)
    if (consumedRemote.has(r)) continue; // already handled above (kept or conflict-resolved)
    // Remote-only entry — union it in so the race doesn't drop the other
    // writer's addition. See KNOWN LIMITATION in the module comment above.
    mergedReviews.push(r);
    added++;
  }

  // Manual-entry URL rescue (see module comment): after the primary-key
  // merge above, a manualEntry review may still sit alongside a separate
  // non-manual "twin" record for the exact same article (byline SWAP, not
  // just formatting drift — the primary key legitimately treated them as
  // different identities). Scoped to manualEntry pairs only: a bare
  // same-URL rule is unsafe in general (7 legitimate same-URL/
  // different-critic pairs exist in the live corpus with no manual entry
  // involved — see module comment).
  let urlRescueConflicts = 0;
  const manualUrlIndex = new Map();
  for (const r of mergedReviews) {
    if (r && r.manualEntry === true) {
      const uk = urlKeyOf(r);
      if (uk && !manualUrlIndex.has(uk)) manualUrlIndex.set(uk, r);
    }
  }
  if (manualUrlIndex.size) {
    for (let i = mergedReviews.length - 1; i >= 0; i--) {
      const r = mergedReviews[i];
      if (!r || r.manualEntry === true) continue;
      const uk = urlKeyOf(r);
      const twin = uk && manualUrlIndex.get(uk);
      if (twin && twin !== r) {
        mergedReviews.splice(i, 1); // the manual twin already present wins
        urlRescueConflicts++;
      }
    }
  }

  const merged = { ...ours, reviews: mergedReviews };
  const lu = newerIso(ours._meta && ours._meta.lastUpdated, remote._meta && remote._meta.lastUpdated);
  const baseMeta = (lu && lu === (remote._meta && remote._meta.lastUpdated) && remote._meta) || ours._meta || remote._meta || {};
  merged._meta = { ...baseMeta, ...(lu ? { lastUpdated: lu } : {}) };
  if (merged._meta.stats && typeof merged._meta.stats === 'object') {
    merged._meta.stats = { ...merged._meta.stats, totalReviews: mergedReviews.length };
  }

  return {
    merged,
    stats: { added, conflicts, conflictsResolvedToRemote, remoteDuplicateKeysSkipped, urlRescueConflicts, totalReviews: mergedReviews.length },
  };
}

module.exports = { mergeReviewsJson, keyOf, urlKeyOf, resolveConflict, snapshotIsNewer, tierRank };
