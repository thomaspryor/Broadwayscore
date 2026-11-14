/**
 * gap-audit-show-filter.js
 *
 * Parses and applies audit-show-review-gap.js's `--show=` value. It takes one
 * show id or a comma-separated list, so a caller that already knows exactly
 * which shows matter (the weekly newsletter's featured openings, BRO-4592) can
 * audit that set directly instead of hoping the hourly back-catalogue grind
 * reaches them.
 *
 * Order is preserved: the caller's list is the priority order, and a time-
 * budgeted run stops at the budget, so the first ids are the ones that get done.
 */

const SHOW_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * @param {string|undefined|null} raw the text after `--show=`
 * @returns {string[]} de-duplicated ids in the order given ([] when empty)
 * @throws {Error} on an id that is not a plausible show slug, so a malformed
 *   workflow input fails loudly instead of silently auditing nothing
 */
function parseShowFilter(raw) {
  if (raw == null || String(raw).trim() === '') return [];
  const seen = new Set();
  const ids = [];
  for (const part of String(raw).split(',')) {
    const id = part.trim();
    if (!id) continue;
    if (!SHOW_ID_RE.test(id)) throw new Error(`Invalid show id in --show: "${id}"`);
    if (!seen.has(id)) { seen.add(id); ids.push(id); }
  }
  return ids;
}

/**
 * @param {Array<{id:string}>} allShows
 * @param {string[]} ids from parseShowFilter
 * @returns {{targets: Array, missing: string[]}} targets in `ids` order
 */
function selectShowsById(allShows, ids) {
  const byId = new Map();
  for (const s of allShows || []) if (s && s.id && !byId.has(s.id)) byId.set(s.id, s);
  const targets = [];
  const missing = [];
  for (const id of ids) {
    const s = byId.get(id);
    if (s) targets.push(s); else missing.push(id);
  }
  return { targets, missing };
}

module.exports = { parseShowFilter, selectShowsById, SHOW_ID_RE };
