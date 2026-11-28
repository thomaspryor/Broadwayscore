'use strict';

/**
 * Shared-ibdbUrl self-heal (decision logic).
 *
 * validate-data.js hard-fails when two shows share an ibdbUrl ("each IBDB
 * production maps to one show; null the stale url on the revival entry so it
 * can't inherit the original production's dates"). That error blocked the
 * Update Show Status discovery commit daily from 2026-07-03 (The Sound of
 * Music 1998/2026, A Few Good Men 1989/2026) until someone hand-edited
 * shows.json. This module implements the validator's prescribed remedy as a
 * sweep: the EARLIEST production keeps the URL, every later entry (the
 * revival that inherited it from a stub/copy) gets it nulled. Enrichment
 * (backfill-ibdb-urls.js / auto-fix-show-data.js) can later re-add the
 * revival's own correct URL.
 */

/** Sort key: openingDate, else previewDate, else trailing year in the id, else +Inf. */
function productionEpoch(show) {
  for (const field of ['openingDate', 'previewDate']) {
    const t = show[field] ? Date.parse(show[field]) : NaN;
    if (!Number.isNaN(t)) return t;
  }
  const yearMatch = /(\d{4})$/.exec(show.id || '');
  if (yearMatch) return Date.parse(`${yearMatch[1]}-01-01`);
  return Infinity;
}

/**
 * Plan which shows should have their ibdbUrl nulled.
 *
 * @param {Array<object>} shows - shows.json entries
 * @returns {Array<{id: string, ibdbUrl: string, keptOn: string}>} one entry
 *   per show that must be cleared (empty array = nothing shared)
 */
function planSharedIbdbUrlFixes(shows) {
  const groups = new Map();
  for (const s of shows) {
    if (!s.ibdbUrl) continue;
    if (!groups.has(s.ibdbUrl)) groups.set(s.ibdbUrl, []);
    groups.get(s.ibdbUrl).push(s);
  }

  const fixes = [];
  for (const [url, members] of groups) {
    if (members.length < 2) continue;
    const sorted = [...members].sort((a, b) => {
      const d = productionEpoch(a) - productionEpoch(b);
      if (d !== 0) return d;
      return String(a.id).localeCompare(String(b.id)); // deterministic tie-break
    });
    const keeper = sorted[0];
    for (const stale of sorted.slice(1)) {
      fixes.push({ id: stale.id, ibdbUrl: url, keptOn: keeper.id });
    }
  }
  return fixes;
}

module.exports = { planSharedIbdbUrlFixes, productionEpoch };
