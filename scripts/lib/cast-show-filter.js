'use strict';

/**
 * Resolve a --show-filter value to shows. The value is one id/slug or a
 * comma-separated list (BRO-2517: the backfill-cast-web workflow keeps only
 * one pending run per concurrency group, so a batch of ids has to arrive as
 * one dispatch). Whitespace around ids is ignored; empty items are dropped.
 *
 * @param {Array<{id?: string, slug?: string}>} shows
 * @param {string|null|undefined} filterValue
 * @returns {{ matched: object[], missing: string[], wanted: string[] }}
 */
function selectShowsByFilter(shows, filterValue) {
  const wanted = [...new Set(String(filterValue || '').split(',').map((s) => s.trim()).filter(Boolean))];
  const list = Array.isArray(shows) ? shows : [];
  const matched = list.filter((s) => wanted.includes(s.id) || wanted.includes(s.slug));
  const missing = wanted.filter((w) => !matched.some((s) => s.id === w || s.slug === w));
  return { matched, missing, wanted };
}

module.exports = { selectShowsByFilter };
