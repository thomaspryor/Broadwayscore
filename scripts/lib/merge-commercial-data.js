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
//
// Merge rules — commercial-research-queue.json:
//   * shape: { shows: [slug, ...], triggers: { [slug]: reason }, updatedAt }
//   * Written by 5 different cron workflows (commercial-weekly, commercial-
//     friday, update-commercial, scrape-waltz-costs, update-show-status) —
//     previously NOT in this file's exemption list, so it fell to the
//     generic "accept remote" case in push-with-retry.sh and silently
//     dropped local queue additions on conflict.
//   * `shows` is a deduped union of both sides' arrays (order: ours first,
//     then remote-only additions appended).
//   * `triggers` is a shallow merge; on key collision, keep whichever side's
//     entry belongs to the union decision for that slug (both sides usually
//     agree on the reason for the same slug — this is a rare edge case).
//   * `updatedAt` becomes the newer of the two timestamps.

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

const PENDING_ENTRY_DATE_FIELDS = ['researchedAt', 'detectedAt', 'lastUpdated'];

function mergePendingReview(ours, remote) {
  ours = ours || { shows: {} };
  remote = remote || { shows: {} };
  const oursShows = ours.shows || {};
  const remoteShows = remote.shows || {};
  const merged = { ...ours };
  merged.shows = { ...oursShows };

  let added = 0;
  let resolvedAsDeletion = 0;
  const allSlugs = new Set([...Object.keys(oursShows), ...Object.keys(remoteShows)]);
  for (const slug of allSlugs) {
    const o = oursShows[slug];
    const r = remoteShows[slug];
    if (!o && r) { merged.shows[slug] = r; added++; continue; }
    if (o && !r) {
      // 10 scripts write/delete individual keys in this file (apply-
      // commercial-pending.js removes applied shows, sweep-pending-
      // commercial.js removes expired ones) on independent cron schedules —
      // "remote lacks a slug ours still has" is ambiguous between "remote's
      // base predates ours' addition" (keep ours, current behavior) and
      // "remote already applied/swept it" (must NOT resurrect — same class
      // of bug as mergeResearchQueue, ship-check finding 2026-07-19,
      // /what-else follow-up). Use ours' entry timestamp vs remote's
      // file-level lastUpdated as a logical clock: if remote's last write
      // happened AFTER this entry existed, remote has definitely seen (and
      // removed) it.
      // Strict '<', not '<=' (ship-check finding, 2026-07-19): equal
      // timestamps don't prove remote saw this entry — could be an
      // unrelated write stamped in the same millisecond. On a tie, default
      // to keeping ours; only delete when remote is UNAMBIGUOUSLY newer.
      const entryTime = entryDate(o, PENDING_ENTRY_DATE_FIELDS);
      const remoteFileTime = entryDate(remote, ['lastUpdated']);
      if (remote.lastUpdated && entryTime > 0 && entryTime < remoteFileTime) {
        delete merged.shows[slug];
        resolvedAsDeletion++;
      }
      continue;
    }
    merged.shows[slug] = pickNewer(o, r, PENDING_ENTRY_DATE_FIELDS);
  }

  // Refresh top-level lastUpdated to whichever side is newer
  const newer = pickNewer(remote, ours, ['lastUpdated']);
  if (newer?.lastUpdated) merged.lastUpdated = newer.lastUpdated;

  return { merged, stats: { added, resolvedAsDeletion, totalSlugs: allSlugs.size } };
}

function mergeResearchQueue(ours, remote) {
  ours = ours || { shows: [], triggers: {} };
  remote = remote || { shows: [], triggers: {} };
  const oursShows = Array.isArray(ours.shows) ? ours.shows : [];
  const remoteShows = Array.isArray(remote.shows) ? remote.shows : [];

  // deep-research-commercial.js consumes the queue by writing {shows: [],
  // updatedAt} after processing. A plain array-union would resurrect those
  // already-researched slugs if a concurrent producer's stale add lands in
  // the same conflict (ship-check finding, 2026-07-19) — reprocessing them
  // forever on every future conflict. Whichever side is BOTH empty and
  // strictly newer is a consumption event and wins outright; only fall
  // through to the additive union when neither side looks like a clear.
  if (oursShows.length === 0 && pickNewer(remote, ours, ['updatedAt']) === ours) {
    return { merged: { ...ours, shows: [], triggers: ours.triggers || {} }, stats: { added: 0, totalShows: 0, resolvedAsConsumption: 'ours' } };
  }
  if (remoteShows.length === 0 && pickNewer(ours, remote, ['updatedAt']) === remote) {
    return { merged: { ...remote, shows: [], triggers: remote.triggers || {} }, stats: { added: 0, totalShows: 0, resolvedAsConsumption: 'remote' } };
  }

  const seen = new Set(oursShows);
  const mergedShows = [...oursShows];
  let added = 0;
  for (const slug of remoteShows) {
    if (!seen.has(slug)) {
      mergedShows.push(slug);
      seen.add(slug);
      added++;
    }
  }

  const merged = { ...ours };
  merged.shows = mergedShows;
  merged.triggers = { ...(remote.triggers || {}), ...(ours.triggers || {}) };

  const newer = pickNewer(remote, ours, ['updatedAt']);
  if (newer?.updatedAt) merged.updatedAt = newer.updatedAt;

  return { merged, stats: { added, totalShows: mergedShows.length } };
}

module.exports = {
  HUMAN_REVIEWED_COMMERCIAL_FIELDS,
  mergeCommercialJson,
  mergePendingReview,
  mergeResearchQueue,
};
