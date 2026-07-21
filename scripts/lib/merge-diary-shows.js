// Array-of-shows merge for data/diary-shows.json.
//
// Why this exists:
//   push-core-data (action.yml) and push-with-retry.sh reconcile shows.json +
//   audience-buzz.json + commercial*.json post-rebase, but diary-shows.json was
//   left to the "-X ours" / "accept remote" default that silently drops one
//   side's additions on a push race. As of Notion 39d637c5 (import self-heal
//   loop) diary-shows.json has THREE independent writers on independent
//   schedules — import-mezzanine-historical.js (manual), resolve-unmatched-
//   imports.js (nightly), refresh-mezzanine-catalog.js (weekly) — each loading
//   the full array, mutating in memory, and rewriting the whole file. Two
//   racing pushes therefore had a data-loss bug of the same class as
//   commercial.json before ship-check CDX-P0-1. Card #176.
//
// Used by:
//   - .github/actions/push-core-data/action.yml (post-rebase reconcile)
//   - scripts/lib/merge-commercial-conflict.js (push-with-retry.sh conflict path)
//   - tests/unit/merge-diary-shows.test.mjs
//
// Merge rules:
//   * shape: { shows: [ { id, mezzanineId, ... }, ... ], lastUpdated }
//   * Natural key: mezzanineId, falling back to id when mezzanineId is absent
//     (older hand-added entries predate the mezzanineId field).
//   * Union of keys is kept: entries present on only one side survive. This is
//     the whole point — neither racing writer's newly-added shows are dropped.
//   * On key collision (both sides carry the entry): keep OURS. This matches
//     the "-X ours" strategy the rebase already applied, and is safe because
//     the three writers only ADD or field-UPDATE entries — none ever deletes,
//     so a union can never resurrect an intentionally-removed show. A field
//     update on a shared entry that loses the race is re-applied on the writer's
//     next scheduled run (Mezzanine re-reports it); a dropped ADDITION is not
//     (the source stub is consumed), which is why additions are the thing this
//     protects.
//   * Order: ours first (original order preserved), then remote-only entries
//     appended in remote order — deterministic, minimal diff.
//   * lastUpdated: the newer of the two ISO timestamps.

function keyOf(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.mezzanineId) return `mz:${entry.mezzanineId}`;
  if (entry.id) return `id:${entry.id}`;
  return null;
}

function newerIso(a, b) {
  const ta = typeof a === 'string' ? Date.parse(a) : NaN;
  const tb = typeof b === 'string' ? Date.parse(b) : NaN;
  if (Number.isNaN(ta)) return b;
  if (Number.isNaN(tb)) return a;
  return tb > ta ? b : a;
}

function mergeDiaryShows(ours, remote) {
  ours = ours && typeof ours === 'object' ? ours : { shows: [] };
  remote = remote && typeof remote === 'object' ? remote : { shows: [] };
  const oursShows = Array.isArray(ours.shows) ? ours.shows : [];
  const remoteShows = Array.isArray(remote.shows) ? remote.shows : [];

  // Keys ours already carries. Keyless entries (no mezzanineId AND no id) are
  // kept verbatim from ours but can't be deduped against remote — they append
  // through unchanged, which is the safe (never-drop) behaviour.
  const oursKeys = new Set();
  for (const e of oursShows) {
    const k = keyOf(e);
    if (k) oursKeys.add(k);
  }

  const mergedShows = [...oursShows];
  let added = 0;
  let kept = 0;
  for (const e of remoteShows) {
    const k = keyOf(e);
    if (k && oursKeys.has(k)) {
      kept++; // shared key — ours already present, keep ours
      continue;
    }
    // Remote-only (or keyless remote entry) — re-add so the race doesn't drop it.
    mergedShows.push(e);
    if (k) oursKeys.add(k);
    added++;
  }

  const merged = { ...ours, shows: mergedShows };
  const lu = newerIso(ours.lastUpdated, remote.lastUpdated);
  if (lu) merged.lastUpdated = lu;

  return {
    merged,
    stats: { added, kept, totalShows: mergedShows.length },
  };
}

module.exports = { mergeDiaryShows, keyOf };
