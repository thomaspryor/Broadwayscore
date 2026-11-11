'use strict';
/**
 * Pure helpers for the OpenAI shutdown drift check (BRO-7339).
 *
 * Why: research-cost.js MODEL_SHUTDOWNS was hand-maintained, so when OpenAI posted
 * the 2026-12-11 shutdown of gpt-5-mini and o3 (notice 2026-06-11) nothing in the
 * repo knew, and the guard in tests/unit/research-cost.test.mjs had nothing to
 * match. This reads OpenAI's own table and diffs it against the registry, limited to
 * model ids the repo actually references (the page also lists hundreds of old ones).
 *
 * Source: https://developers.openai.com/api/docs/deprecations — tables with the
 * columns "Shutdown date | Model / system | Recommended replacement"; ids sit in <code>.
 */

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** "Dec 11, 2026" / "February 10, 2027" -> "2026-12-11"; null if it is not a date. */
function parseShutdownDate(text) {
  const m = String(text || '').replace(/\s+/g, ' ').trim().match(/^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})$/);
  if (!m) return null;
  const mon = MONTHS[m[1].slice(0, 3).toLowerCase()];
  if (!mon) return null;
  return `${m[3]}-${String(mon).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}`;
}

/** Strip a dated-snapshot suffix: gpt-5-mini-2025-08-07 -> gpt-5-mini. */
function baseId(id) {
  return String(id || '').replace(/-\d{4}-\d{2}-\d{2}$/, '');
}

const stripTags = (h) => String(h).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

/**
 * @param {string} html - the deprecations page
 * @returns {{shutdown:string, ids:string[], replacement:string|null}[]} one row per table row
 *   that has a parseable shutdown date and at least one <code> model id. `ids` holds
 *   the ids exactly as listed (aliases and dated snapshots), de-duplicated.
 */
function parseDeprecations(html) {
  const rows = [];
  for (const tr of String(html).match(/<tr[\s\S]*?<\/tr>/g) || []) {
    const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
    if (cells.length < 2) continue;
    const shutdown = parseShutdownDate(stripTags(cells[0]));
    if (!shutdown) continue;
    const ids = [...new Set([...cells[1].matchAll(/<code[^>]*>([^<]+)<\/code>/g)].map((m) => m[1].trim()))];
    if (!ids.length) continue;
    const rep = cells[2] && cells[2].match(/<code[^>]*>([^<]+)<\/code>/);
    rows.push({ shutdown, ids, replacement: rep ? rep[1].trim() : null });
  }
  return rows;
}

/**
 * OpenAI model ids a source file names in quotes (gpt-*, o-series, embeddings).
 * Callers pass non-test source only; ids are returned as base aliases.
 */
function referencedModelIds(source) {
  const out = new Set();
  const re = /['"`]((?:gpt-\d[\w.-]*)|(?:o\d(?:-[a-z]+)*)|(?:chatgpt-[\w.-]+)|(?:text-embedding-[\w-]+))['"`]/g;
  for (const m of String(source).matchAll(re)) out.add(baseId(m[1]));
  return out;
}

/**
 * @param {object} p
 * @param {{shutdown:string, ids:string[]}[]} p.page - parseDeprecations() output
 * @param {Object<string,string>} p.registry - id -> ISO date the repo already knows
 *   (MODEL_SHUTDOWNS plus ACCEPTED_SHUTDOWNS)
 * @param {Iterable<string>} p.referenced - base ids the repo uses
 * @param {string} p.today - YYYY-MM-DD
 * @param {number} [p.warnDays=60]
 * @returns {{missing:object[], dateDrift:object[], soon:object[]}}
 *   missing: the repo uses it, the page schedules its shutdown, the registry is silent.
 *   dateDrift: registry date differs from the page. soon: shutdown still ahead and within warnDays.
 */
function driftReport({ page, registry, referenced, today, warnDays = 60 }) {
  const refs = new Set([...referenced].map(baseId));
  // An alias row (gpt-4o) is exact. A dated snapshot row (gpt-4o-2024-05-13) says
  // nothing about the alias until every snapshot is gone, so snapshot dates fold into
  // the alias only when it has no row of its own, and the LATEST snapshot date wins
  // (the live alias points at the newest snapshot; gpt-4o-2024-05-13 retiring in
  // Oct 2026 must not read as the gpt-4o alias retiring).
  const exact = new Map();
  const viaSnapshot = new Map();
  for (const row of page) for (const id of row.ids) {
    const alias = baseId(id);
    if (alias === id) {
      if (!exact.has(id) || row.shutdown < exact.get(id).shutdown) exact.set(id, row);
    } else if (!viaSnapshot.has(alias) || row.shutdown > viaSnapshot.get(alias).shutdown) viaSnapshot.set(alias, row);
  }
  const pageDate = { get: (id) => exact.get(id) || viaSnapshot.get(id) };
  const days = (iso) => Math.round((Date.parse(iso) - Date.parse(today)) / 86400000);
  const missing = [];
  const dateDrift = [];
  const soon = [];
  for (const id of [...refs].sort()) {
    const row = pageDate.get(id);
    if (!row) continue;
    const known = registry[id];
    if (!known) missing.push({ id, shutdown: row.shutdown, replacement: row.replacement, daysLeft: days(row.shutdown) });
    else if (known !== row.shutdown) dateDrift.push({ id, registry: known, page: row.shutdown });
    if (days(row.shutdown) >= 0 && days(row.shutdown) <= warnDays) soon.push({ id, shutdown: row.shutdown, replacement: row.replacement, daysLeft: days(row.shutdown) });
  }
  return { missing, dateDrift, soon };
}

module.exports = { parseShutdownDate, baseId, parseDeprecations, referencedModelIds, driftReport };
