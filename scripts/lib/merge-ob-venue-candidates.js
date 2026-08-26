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
// KNOWN LIMITATION (second-opinion review, 2026-08-26 — same shape as
// mergeDiaryShows's field-update limitation, scoped to removal instead of
// updates): this is a pure key UNION with no tombstone, so it can't
// represent "this hash was intentionally removed." promote-ob-venue-
// candidates.js's rewriteStaging() and extract-aggregator-candidates.js's
// pruneStagedCandidates() both remove a candidateHash once its show has
// landed in shows.json via any path. If that removal conflicts with a
// remote copy that hasn't observed it yet (hasn't re-run its own prune
// since), the union merge RESURRECTS the hash for one cycle — it reappears
// in staging even though it's already a real show. This self-heals: the
// next promote/extract run re-derives the same "already in shows.json"
// verdict and prunes it again. Accepted because the alternative (a
// persisted tombstone list) is out of this ticket's scope and the failure
// mode this fix exists to close — a candidate silently LOST forever — is
// categorically worse than a candidate transiently reappearing for one
// cycle. See the "collision, ours pruned + remote still has it" test below.
function keyOf(entry) {
  if (!entry || typeof entry !== 'object') return null;
  return entry.candidateHash || null;
}

function mergeObVenueCandidates(ours, remote) {
  const oursList = Array.isArray(ours) ? ours : [];
  const remoteList = Array.isArray(remote) ? remote : [];

  const oursKeys = new Set();
  for (const e of oursList) {
    const k = keyOf(e);
    if (k) oursKeys.add(k);
  }

  const merged = [...oursList];
  let added = 0;
  let kept = 0;
  for (const e of remoteList) {
    const k = keyOf(e);
    if (k && oursKeys.has(k)) {
      kept++; // shared key — ours already present, keep ours
      continue;
    }
    merged.push(e);
    if (k) oursKeys.add(k);
    added++;
  }

  return {
    merged,
    stats: { added, kept, total: merged.length },
  };
}

module.exports = { mergeObVenueCandidates, keyOf };
