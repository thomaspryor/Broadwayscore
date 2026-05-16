/**
 * Bulk import preflight — pure metadata-gate functions for
 * run-bulk-historical-import.js. Extracted per CLAUDE.md §15 so tests
 * can require() the gate without spawning child processes or reading
 * shows.json from disk.
 *
 * Notion 362637c5-416f-81ee — null category/market on bulk-inserted
 * shows breaks opening-night-orchestrator routing (Schmigadoon
 * postmortem). The gate refuses the whole batch up front so the operator
 * fixes discover-historical-shows output, not the downstream symptom.
 */

'use strict';

/**
 * checkShowsJsonMetadata — verify every id in `ids` has a row in `shows`
 * with non-empty category AND market.
 *
 * @param {Array<{id: string, category?: string, market?: string}>} shows
 * @param {Array<string>} ids
 * @returns {{ ok: boolean, missing: string[], nullCategory: string[], nullMarket: string[] }}
 */
function checkShowsJsonMetadata(shows, ids) {
  const byId = new Map(shows.map(s => [s.id, s]));
  const missing = [];
  const nullCategory = [];
  const nullMarket = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) { missing.push(id); continue; }
    if (!row.category) nullCategory.push(id);
    if (!row.market) nullMarket.push(id);
  }
  const ok = missing.length === 0 && nullCategory.length === 0 && nullMarket.length === 0;
  return { ok, missing, nullCategory, nullMarket };
}

module.exports = { checkShowsJsonMetadata };
