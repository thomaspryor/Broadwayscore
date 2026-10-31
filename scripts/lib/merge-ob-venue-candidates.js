// Array-of-candidates merge for data/audit/ob-venue-candidates.json (BRO-158).
//
// Why this exists:
//   The staging file has 4 independent producers — discover-new-shows.js's
//   OB venue fan-out, add-requested-show.js, extract-aggregator-
//   candidates.js, and promote-ob-venue-candidates.js's post-promotion
//   prune — each running in its OWN GitHub Actions checkout (separate
//   runners, no shared filesystem). scripts/lib/venue-listing-discover.js's
//   updateStaging()/withFileLock only protects a same-host read-modify-write
//   (e.g. two local scripts sharing one checkout); it CANNOT protect against
//   two producers pushing from two different runners, which is the actual
//   race this ticket names ("the #788 class", reproduced as a real merge
//   conflict during the 2026-08-03 session). Before this file, a real
//   conflict on ob-venue-candidates.json fell to push-with-retry.sh's
//   generic `data/collection-state/*|data/audit/*)` case — "keep our run's
//   version" — a whole-file overwrite that silently drops every candidate
//   the OTHER run staged or pruned. Same data-loss class already fixed for
//   commercial.json (CDX-P0-1), diary-shows.json (#176), and
//   express-retry-queue.json (#1889) — see those merge-*.js siblings.
//
// Used by:
//   - scripts/lib/merge-commercial-conflict.js (push-with-retry.sh conflict path)
//   - scripts/lib/core-data-merge-registry.js (registers this file + fn)
//
// Merge rules:
//   * shape: a bare array of candidate objects (NOT wrapped in an object —
//     see venue-listing-discover.js's loadStaging/writeStaging).
//   * Natural key: candidateHash (title+venue hash — see venue-listing-
//     discover.js's candidateHash()). Keyless entries (malformed/legacy rows
//     without a candidateHash) are kept verbatim from ours but can't be
//     deduped against remote — they pass through unchanged (safe, never
//     drops a row) and remote's own keyless rows are appended too, since a
//     missing hash on one side says nothing about whether the OTHER side's
//     keyless row is the same candidate or a different one.
//   * Union of keys is kept: a candidate staged (or pruned away) on only one
//     side survives (or stays removed) — this is the whole point.
//   * On key collision (both sides carry the hash): keep OURS, matching the
//     "-X ours" rebase strategy already applied upstream, same convention as
//     mergeDiaryShows/mergeExpressRetryQueue. Safe because collisions are
//     re-discoveries of the same (title, venue) pair — dropping one side's
//     copy loses only a refreshed discoveredAt/evidence, never a distinct
//     candidate.
//   * Order: ours first (original order preserved), then remote-only entries
//     appended in remote order — deterministic, minimal diff.
//
// Three-way mode (BRO-4484): the merge also takes the common-ancestor
// content `base`, which every push-path caller already supplies to a merger
// whose arity is 3 (merge-commercial-conflict.js reads git stage :1:,
// push-via-git-api-merge.js the run's entry base, reconcile-merged-json.js
// PUSH_RECONCILE_BASE). With a base, removals are honoured instead of
// unioned back:
//   * a remote-only key that base also carries, with remote's row unchanged
//     since base, is a row WE removed (the promoter's prune) -> stays removed;
//   * an ours key that base also carries, absent from remote, with our row
//     unchanged since base, is a row THEY removed -> dropped too.
// A row edited on the side that kept it (re-staged with fresh evidence)
// wins over the other side's removal; it comes back once and the next prune
// re-derives the verdict. "Unchanged" compares rows with sorted keys, so a
// writer that reorders fields is not an edit. Only delete-vs-edit is
// three-way: on a shared key ours still wins. On a push retry, ours already
// carries rows an earlier attempt merged in that the base predates; if
// another writer pruned one meanwhile it returns for one cycle (self-heals).
// A writer must never rewrite a file it could not parse (that would read as
// "pruned every row"): both updateStaging helpers refuse to (BRO-4484).
//
// Before this, the merge was a pure key union: on 2026-09-29/30 the OWE
// promoter's pruned staging file was unioned back to its pre-prune content
// whenever main moved mid-run, final == base, and push-content-survival.js
// classified the push REVERTED on every attempt (the run went red daily).
//
// No base (undefined / non-array: an add/add conflict, a missing or
// unreadable ancestor) -> the original two-way union, unchanged, including
// its KNOWN LIMITATION (second-opinion review, 2026-08-26): a hash ours
// pruned that remote still carries is resurrected for one cycle and pruned
// again next run. A wrong base is worse than none (it would drop rows other
// writers added), so callers pass a base only when they have the true one;
// reconcile-merged-json.js marks this merger `requiresTrueBase`.
function keyOf(entry) {
  if (!entry || typeof entry !== 'object') return null;
  return entry.candidateHash || null;
}

// Order-insensitive serialization for the "unchanged since base" test.
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/**
 * Factory: the same key-union (three-way when given a base) merge for any bare-array candidate staging file
 * (BRO-4268 second-opinion finding: the Off-West End file needs the exact
 * same rules and two hand-written twins would drift). `keyOf(entry)` returns
 * the natural key or null; keyless rows on either side pass through as
 * documented above.
 */
function makeVenueCandidatesMerge(keyOfFn) {
  function mergeVenueCandidates(ours, remote, base) {
    const oursList = Array.isArray(ours) ? ours : [];
    const remoteList = Array.isArray(remote) ? remote : [];
    // Key -> canonical row in base; null when there is no usable base.
    let baseRows = null;
    if (Array.isArray(base)) {
      baseRows = new Map();
      for (const e of base) {
        const k = keyOfFn(e);
        if (k && !baseRows.has(k)) baseRows.set(k, canonical(e));
      }
    }
    const unchangedSinceBase = (k, e) => baseRows !== null && baseRows.get(k) === canonical(e);

    const remoteKeys = new Set();
    for (const e of remoteList) {
      const k = keyOfFn(e);
      if (k) remoteKeys.add(k);
    }
    const oursKeys = new Set();
    const merged = [];
    let theirDeletes = 0;
    for (const e of oursList) {
      const k = keyOfFn(e);
      if (k && !remoteKeys.has(k) && unchangedSinceBase(k, e)) {
        theirDeletes++; // remote removed it and we never touched it
        continue;
      }
      merged.push(e);
      if (k) oursKeys.add(k);
    }
    let added = 0;
    let kept = 0;
    let ourDeletes = 0;
    for (const e of remoteList) {
      const k = keyOfFn(e);
      if (k && oursKeys.has(k)) {
        kept++; // shared key — ours already present, keep ours
        continue;
      }
      if (k && unchangedSinceBase(k, e)) {
        ourDeletes++; // we removed it (promoter prune) and remote never touched it
        continue;
      }
      merged.push(e);
      if (k) oursKeys.add(k);
      added++;
    }
    const stats = { added, kept, total: merged.length };
    if (baseRows !== null) Object.assign(stats, { ourDeletes, theirDeletes });
    return { merged, stats };
  }
  // reconcile-merged-json.js: never hand this merger a guessed base (the
  // post-rebase merge-base is origin's tip, which would read every row other
  // writers added as "we removed it"); no true base -> two-way union.
  mergeVenueCandidates.requiresTrueBase = true;
  return mergeVenueCandidates;
}
const mergeObVenueCandidates = makeVenueCandidatesMerge(keyOf);

module.exports = { mergeObVenueCandidates, keyOf, makeVenueCandidatesMerge };
