// Two-level keyed-union merge for data/grosses-history.json (BRO-76).
//
// Why this exists: shape { _meta, weeks: { [isoDate]: { [slug]: entry } } },
// written by weekly-grosses.yml (concurrency group data-grosses-writers) AND
// backfill-grosses.yml (manual dispatch, NO concurrency group — the real,
// if rare, race). One of the CORE_FILES with zero reconciliation: a push
// race fell to `-X ours`, and an entire week's worth of backfilled grosses
// data (every slug in that week) could vanish if it landed the losing side
// of a concurrent push.
//
// Merge rule: union at both levels. New weeks from either side are kept in
// full; for a week present on both sides, union its slugs (remote-only slugs
// added); for a slug present on both sides within the same week, keep ours
// (no per-entry timestamp exists to break the tie more precisely — same
// convention as merge-awards-json.js).

function mergeGrossesHistory(ours, remote) {
  ours = ours || { weeks: {} };
  remote = remote || { weeks: {} };
  const oursWeeks = ours.weeks || {};
  const remoteWeeks = remote.weeks || {};
  const merged = { ...ours };
  merged.weeks = { ...oursWeeks };

  let weeksAdded = 0, slugsAdded = 0;
  const allWeeks = new Set([...Object.keys(oursWeeks), ...Object.keys(remoteWeeks)]);
  for (const week of allWeeks) {
    const o = oursWeeks[week];
    const r = remoteWeeks[week];
    if (!o && r) { merged.weeks[week] = r; weeksAdded++; continue; }
    if (o && !r) continue; // keep ours as-is
    if (!o && !r) continue;

    // Both sides have this week — union slugs, ours wins on a shared slug.
    const combined = { ...r, ...o };
    const remoteOnlySlugs = Object.keys(r).filter((s) => !(s in o));
    slugsAdded += remoteOnlySlugs.length;
    merged.weeks[week] = combined;
  }

  if (remote._meta?.lastUpdated || ours._meta?.lastUpdated) {
    const oursT = Date.parse(ours._meta?.lastUpdated || 0) || 0;
    const remoteT = Date.parse(remote._meta?.lastUpdated || 0) || 0;
    merged._meta = { ...(ours._meta || {}), ...(remote._meta || {}), lastUpdated: remoteT > oursT ? remote._meta.lastUpdated : ours._meta.lastUpdated };
  }

  return { merged, stats: { weeksAdded, slugsAdded, totalWeeks: allWeeks.size } };
}

module.exports = { mergeGrossesHistory };
