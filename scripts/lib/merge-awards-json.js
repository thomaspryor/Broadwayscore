// Per-slug JSON merge for data/awards.json (BRO-76).
//
// Why this exists:
//   awards.json is one of the CORE_FILES pushed through the PRIVATE data repo
//   by .github/actions/push-core-data/action.yml, but — unlike shows.json/
//   commercial.json/diary-shows.json — it had NO reconciliation: a push race
//   fell straight to `-X ours`, silently dropping the losing side's award
//   data. Real risk: update-precursor-awards.yml and update-tony-awards.yml
//   both write this file on independent, overlapping seasonal schedules
//   (April-June).
//
// Shape: { _meta: {...}, shows: { [slug]: { [ceremonyKey]: entry, ... } } }
//   e.g. shows['chicago-1996'] = { tony: {...}, drama-desk: {...} }
//   There is no per-slug or per-ceremony timestamp field anywhere in this
//   file — every writer script (canonicalize-award-categories.js,
//   enrich-olivier-awards.js, fix-tony-attribution.js,
//   rebuild-awards-from-precursors.js, scrape-tony-awards.js) rewrites whole
//   ceremony sub-objects, never touches _meta.lastUpdated per-entry.
//
// Merge rule: union of slugs (remote-only additions kept). For a slug present
// on both sides, deep-union its ceremony keys — a show awarded BOTH Tony
// (update-tony-awards) and Olivier (update-precursor-awards) in the same
// push race keeps both ceremonies instead of one side's write clobbering the
// other's. On the rare case both sides wrote the SAME ceremony key for the
// same slug, keep ours (matches the pre-existing `-X ours` convention this
// reconciliation sits on top of — no timestamp exists to break the tie any
// more precisely).

function mergeAwardsJson(ours, remote) {
  ours = ours || { shows: {} };
  remote = remote || { shows: {} };
  const oursShows = ours.shows || {};
  const remoteShows = remote.shows || {};
  const merged = { ...ours };
  merged.shows = { ...oursShows };

  let added = 0, ceremoniesAdded = 0, kept = 0;
  const allSlugs = new Set([...Object.keys(oursShows), ...Object.keys(remoteShows)]);
  for (const slug of allSlugs) {
    const o = oursShows[slug];
    const r = remoteShows[slug];
    if (!o && r) { merged.shows[slug] = r; added++; continue; }
    if (o && !r) { kept++; continue; }
    if (!o && !r) continue;

    // Both sides have the slug — deep-union ceremony keys.
    const combined = { ...r, ...o }; // ours wins on a shared ceremony key
    const remoteOnlyKeys = Object.keys(r).filter((k) => !(k in o));
    if (remoteOnlyKeys.length) ceremoniesAdded += remoteOnlyKeys.length;
    merged.shows[slug] = combined;
  }

  if (remote._meta?.lastUpdated || ours._meta?.lastUpdated) {
    const oursT = Date.parse(ours._meta?.lastUpdated || 0) || 0;
    const remoteT = Date.parse(remote._meta?.lastUpdated || 0) || 0;
    merged._meta = { ...(ours._meta || {}), ...(remote._meta || {}), lastUpdated: remoteT > oursT ? remote._meta.lastUpdated : ours._meta.lastUpdated };
  }

  return { merged, stats: { added, ceremoniesAdded, kept, totalSlugs: allSlugs.size } };
}

module.exports = { mergeAwardsJson };
