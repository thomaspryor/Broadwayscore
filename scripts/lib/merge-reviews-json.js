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
// scripts/rebuild-all-reviews.js is the SOLE writer of reviews.json (grep
// confirms it — every other script/workflow above only writes individual
// data/review-texts/{showId}/*.json files, then triggers a rebuild). Each
// writer's rebuild fully REGENERATES the reviews array from whatever
// review-texts corpus is on disk at that moment. So a push race between two
// concurrent rebuilds is really "two full snapshots of mostly-the-same
// corpus, taken moments apart" — nothing in this array is ever incrementally
// patched in place the way diary-shows.json's three writers add rows.
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
//   * key: showId + outlet + criticName, lower-cased/trimmed — mirrors
//     rebuild-all-reviews.js's own pass-2 outlet-name dedup key (~line 4930:
//     `${showId}|${outlet.toLowerCase().trim()}|${criticName.toLowerCase().trim()}`),
//     so this merge groups exactly the records rebuild itself already treats
//     as the same review. Verified unique across the full production corpus
//     (19,903 reviews, zero collisions) — showId+outletId alone is NOT
//     unique (723 collisions: multi-critic outlets carry several reviews per
//     outlet, disambiguated only by critic).
//   * disjoint keys (present on only one side): union — both sides'
//     additions survive. Safe by the same reasoning as mergeDiaryShows:
//     every writer only adds/updates review-texts files and reruns a full
//     rebuild; nothing here deletes a review-texts file mid-race, so a key
//     missing from one side is virtually always that side's rebuild
//     predating the other writer's newly-collected review, not an
//     intentional drop.
//     KNOWN LIMITATION (mirrors mergeDiaryShows' field-update limitation):
//     if a review was excluded from ours' rebuild by a flag applied to its
//     review-texts file moments before this run (wrongProduction, etc.)
//     while remote's older snapshot still carries the pre-flag entry, the
//     union could resurrect it for one push cycle. reviews.json carries no
//     flag data itself to detect this from the snapshot alone. Accepted
//     because every one of the 20+ writers independently reruns
//     rebuild-all-reviews.js from the current review-texts corpus on its own
//     schedule (the tightest is llm-ensemble-score / enrich-reviews, hours
//     apart) — the very next rebuild re-excludes the flag from a fresh
//     review-texts read, so the exposure window is one push cycle, not
//     permanent silent corruption.
//   * same-key conflict, in order: manualEntry wins over non-manual; else
//     higher contentTier wins (complete > truncated > excerpt > stub >
//     invalid > untiered); else newer publishDate; else ours (matches the
//     rebase's own `-X ours` default when every other signal ties).
//   * _meta: newer lastUpdated wins (whole object, so its stats travel
//     together); totalReviews is corrected afterward to the actual merged
//     count, since the two sides' totalReviews almost never equals the
//     union's length.

const TIER_RANK = { complete: 5, truncated: 4, excerpt: 3, stub: 2, invalid: 1 };

function tierRank(review) {
  return TIER_RANK[review && review.contentTier] || 0;
}

function keyOf(review) {
  if (!review || typeof review !== 'object' || !review.showId) return null;
  const outlet = String(review.outlet || 'unknown').toLowerCase().trim();
  const critic = String(review.criticName || 'unknown').toLowerCase().trim();
  return `${review.showId}|${outlet}|${critic}`;
}

function newerIso(a, b) {
  const ta = typeof a === 'string' ? Date.parse(a) : NaN;
  const tb = typeof b === 'string' ? Date.parse(b) : NaN;
  if (Number.isNaN(ta)) return b;
  if (Number.isNaN(tb)) return a;
  return tb > ta ? b : a;
}

/** Resolve a same-key conflict. Returns 'ours' | 'remote'. */
function resolveConflict(ours, remote) {
  const oursManual = ours.manualEntry === true;
  const remoteManual = remote.manualEntry === true;
  if (oursManual !== remoteManual) return oursManual ? 'ours' : 'remote';

  const oursTier = tierRank(ours);
  const remoteTier = tierRank(remote);
  if (oursTier !== remoteTier) return oursTier > remoteTier ? 'ours' : 'remote';

  const oursDate = ours.publishDate || '';
  const remoteDate = remote.publishDate || '';
  if (oursDate !== remoteDate) return oursDate > remoteDate ? 'ours' : 'remote';

  return 'ours';
}

function mergeReviewsJson(ours, remote) {
  ours = ours && typeof ours === 'object' ? ours : { reviews: [] };
  remote = remote && typeof remote === 'object' ? remote : { reviews: [] };
  const oursReviews = Array.isArray(ours.reviews) ? ours.reviews : [];
  const remoteReviews = Array.isArray(remote.reviews) ? remote.reviews : [];

  const remoteByKey = new Map();
  for (const r of remoteReviews) {
    const k = keyOf(r);
    if (k) remoteByKey.set(k, r);
  }

  const oursKeys = new Set();
  const mergedReviews = [];
  let conflicts = 0;
  let conflictsResolvedToRemote = 0;

  for (const r of oursReviews) {
    const k = keyOf(r);
    if (!k) {
      // Keyless (no showId) — keep verbatim, can't be deduped against remote.
      mergedReviews.push(r);
      continue;
    }
    oursKeys.add(k);
    const remoteMatch = remoteByKey.get(k);
    if (!remoteMatch) {
      mergedReviews.push(r);
      continue;
    }
    conflicts++;
    if (resolveConflict(r, remoteMatch) === 'remote') {
      mergedReviews.push(remoteMatch);
      conflictsResolvedToRemote++;
    } else {
      mergedReviews.push(r);
    }
  }

  let added = 0;
  for (const r of remoteReviews) {
    const k = keyOf(r);
    if (k && oursKeys.has(k)) continue; // already handled above (kept or conflict-resolved)
    // Remote-only (or keyless remote entry) — union it in so the race
    // doesn't drop the other writer's addition.
    mergedReviews.push(r);
    added++;
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
    stats: { added, conflicts, conflictsResolvedToRemote, totalReviews: mergedReviews.length },
  };
}

module.exports = { mergeReviewsJson, keyOf, resolveConflict, tierRank };
