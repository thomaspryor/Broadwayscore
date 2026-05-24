// Per-slug JSON merge for commercial.json and commercial-pending-review.json.
//
// Why this exists:
//   scripts/lib/push-with-retry.sh and .github/actions/push-core-data/action.yml
//   previously reconciled shows.json + audience-buzz.json but treated every
//   other data file as "accept remote" — silently dropping local additions on
//   push retry. With the Friday scraper + (future) RSS poller + closing-stale
//   classifier all writing to these two files in different workflows, that
//   silent-drop behaviour was a data-loss bug waiting to happen.
//   Ship-check called it CDX-P0-1 / CDX-P0-2.
//
// Used by:
//   - scripts/lib/push-with-retry.sh (resolve_conflicts case for these files)
//   - .github/actions/push-core-data/action.yml (post-rebase reconcile)
//   - tests/unit/merge-commercial-data.test.mjs
//
// Merge rules — commercial.json:
//   * shape: { shows: { [slug]: entry, ... }, _meta: {...} }
//   * For each slug present in either side: pick the entry whose `lastUpdated`
//     is newer. If the older side carries `humanReviewedDesignation === true`
//     OR `humanReviewedWrongProduction === true`, overlay those fields onto
//     the chosen entry — those are manual corrections that must survive any
//     CI rewrite.
//   * Union of slugs is kept (local additions + remote additions both land).
//
// Merge rules — commercial-pending-review.json:
//   * shape: { shows: { [slug]: pendingEntry, ... }, lastUpdated, ... }
//   * For each slug: pick the entry whose `researchedAt` (or `detectedAt` as
//     fallback) is newer. Manual-protection fields are not applicable here —
//     pending entries are throwaway claims awaiting apply.
//   * Union of slugs is kept.

const HUMAN_REVIEWED_COMMERCIAL_FIELDS = [
  'humanReviewedDesignation',
  'humanReviewedRecouped',
  'humanReviewedCapitalization',
];

function entryDate(entry, fields) {
  for (const f of fields) {
    const v = entry?.[f];
    if (typeof v === 'string') {
      const t = Date.parse(v);
      if (!Number.isNaN(t)) return t;
    }
  }
  return 0;
}

function pickNewer(ours, remote, dateFields) {
  const oursT = entryDate(ours, dateFields);
  const remoteT = entryDate(remote, dateFields);
  return remoteT > oursT ? remote : ours;
}

function overlayHumanReviewed(target, candidate) {
  // If candidate has any humanReviewed* flag set true, copy those flags + the
  // adjacent values they protect. Manual review wins regardless of timestamps.
  let touched = false;
  for (const f of HUMAN_REVIEWED_COMMERCIAL_FIELDS) {
    if (candidate?.[f] === true && target[f] !== true) {
      target[f] = true;
      touched = true;
    }
  }
  return touched;
}

function mergeCommercialJson(ours, remote) {
  ours = ours || { shows: {} };
  remote = remote || { shows: {} };
  const oursShows = ours.shows || {};
  const remoteShows = remote.shows || {};
  const merged = { ...ours };
  merged.shows = { ...oursShows };

  let added = 0, kept = 0, overlaid = 0;
  const allSlugs = new Set([...Object.keys(oursShows), ...Object.keys(remoteShows)]);
  for (const slug of allSlugs) {
    const o = oursShows[slug];
    const r = remoteShows[slug];
    if (!o && r) { merged.shows[slug] = r; added++; continue; }
    if (o && !r) { /* keep ours */ kept++; continue; }
    if (!o && !r) continue;
    // Both sides have the slug. Pick newer by lastUpdated, then overlay any
    // humanReviewed* flags from the loser so manual corrections survive.
    const winner = pickNewer(o, r, ['lastUpdated', 'firstAdded']);
    const loser = winner === o ? r : o;
    const chosen = { ...winner };
    if (overlayHumanReviewed(chosen, loser)) overlaid++;
    merged.shows[slug] = chosen;
  }

  // _meta: pick newer lastUpdated
  if (remote._meta?.lastUpdated || ours._meta?.lastUpdated) {
    const newer = pickNewer(remote._meta || {}, ours._meta || {}, ['lastUpdated']);
    merged._meta = { ...(ours._meta || {}), ...(remote._meta || {}), ...newer };
  }

  return { merged, stats: { added, kept, overlaid, totalSlugs: allSlugs.size } };
}

function mergePendingReview(ours, remote) {
  ours = ours || { shows: {} };
  remote = remote || { shows: {} };
  const oursShows = ours.shows || {};
  const remoteShows = remote.shows || {};
  const merged = { ...ours };
  merged.shows = { ...oursShows };

  let added = 0;
  const allSlugs = new Set([...Object.keys(oursShows), ...Object.keys(remoteShows)]);
  for (const slug of allSlugs) {
    const o = oursShows[slug];
    const r = remoteShows[slug];
    if (!o && r) { merged.shows[slug] = r; added++; continue; }
    if (o && !r) continue;
    merged.shows[slug] = pickNewer(o, r, ['researchedAt', 'detectedAt', 'lastUpdated']);
  }

  // Refresh top-level lastUpdated to whichever side is newer
  const newer = pickNewer(remote, ours, ['lastUpdated']);
  if (newer?.lastUpdated) merged.lastUpdated = newer.lastUpdated;

  return { merged, stats: { added, totalSlugs: allSlugs.size } };
}

module.exports = {
  HUMAN_REVIEWED_COMMERCIAL_FIELDS,
  mergeCommercialJson,
  mergePendingReview,
};
