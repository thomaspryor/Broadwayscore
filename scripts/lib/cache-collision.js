'use strict';

/**
 * cache-collision.js — the shared writer-side guard for showId -> url/slug
 * caches (BRO-4060, generalising BRO-4055).
 *
 * Every one of these caches maps ONE production (a showId) to ONE aggregator
 * page. Their writers used to check only "does THIS showId already have a
 * value", never "does this VALUE already belong to a DIFFERENT showId". So a
 * same-title sibling production (a revival, a transfer, a return run) could be
 * matched onto the page another production already owns, and a hand-removed
 * wrong mapping came straight back on the next discovery pass. That is the
 * she-loves-me-1994/-2016 Show Score incident (BRO-4055) and, in
 * data/dtli-slug-map.json, death-of-a-salesman-1999 and -2026 both pointing at
 * DTLI's death-of-a-salesman-3 page.
 *
 * Covered caches and their writers:
 *   data/show-score-urls.json — show-score-url-map.js findConflictingShowId
 *     (delegates here; its five callers are unchanged)
 *   data/playbill-urls.json   — playbill-urls-store.js applyDelta, so all four
 *     writers that save through the store get it
 *   data/dtli-slug-map.json   — discover-dtli-slugs.js, watch-aggregator-urls.js
 *   data/westend-slug-map.json — westend-slug-discovery.js
 *
 * Pure: no fs. Map values may be a bare string (url or slug) or an object with
 * a `.url` (westend-slug-map's { url, discoveredAt } / { notFoundAt } shape).
 */

// Comparison key: case, surrounding whitespace, protocol, a leading "www."
// and trailing slashes never make two values different pages. Works for bare
// slugs too (they pass through lower-cased and trimmed).
function normalizeCacheValue(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '');
}

// The comparable value of one cache entry, or null for an entry that claims
// nothing (a negative-cache { notFoundAt } record, null, '').
function cacheEntryValue(entry) {
  if (typeof entry === 'string') return entry || null;
  if (entry && typeof entry === 'object' && typeof entry.url === 'string') return entry.url || null;
  return null;
}

/**
 * Call BEFORE writing map[key] = value. Returns the OTHER key that already
 * claims the same (normalized) value, or null when the write is safe.
 * Re-writing a key's own value is never a conflict.
 *
 * @param {Record<string, unknown>|null|undefined} map
 * @param {string} key
 * @param {unknown} value  a url/slug string, or an entry object with .url
 * @returns {string|null}
 */
function findConflictingKey(map, key, value) {
  const raw = cacheEntryValue(value);
  if (!raw) return null;
  const target = normalizeCacheValue(raw);
  if (!target) return null;
  for (const [otherKey, entry] of Object.entries(map || {})) {
    if (otherKey === key) continue;
    const existing = cacheEntryValue(entry);
    if (existing && normalizeCacheValue(existing) === target) return otherKey;
  }
  return null;
}

/**
 * Apply a batch of assignments { key: value } to a map, refusing any that
 * would give a value to a second key. Used by batch writers (discover-dtli-
 * slugs.js) where several keys may be re-pointed in one run, so the check has
 * to see the batch's own moves: a key being reassigned in this batch releases
 * its old value first, and assignments earlier in the batch claim theirs.
 *
 * Two or more keys in the SAME batch claiming one value is ambiguous (which
 * sibling production owns the page?), so all of them are refused rather than
 * letting iteration order pick; a human or a --force year-rule pass decides.
 *
 * A refused key keeps its previous value when that value is still unclaimed;
 * otherwise it is left unmapped (never two owners).
 *
 * @param {Record<string, unknown>} map  not mutated
 * @param {Record<string, unknown>} assignments
 * @returns {{ map: Record<string, unknown>, refused: Array<{key: string, value: unknown, owner: string}> }}
 */
function applyAssignmentsWithoutCollisions(map, assignments) {
  const next = { ...(map || {}) };
  const previous = {};
  for (const key of Object.keys(assignments || {})) {
    if (Object.prototype.hasOwnProperty.call(next, key)) previous[key] = next[key];
    delete next[key];
  }
  const claimants = new Map(); // normalized value -> keys in this batch
  for (const [key, value] of Object.entries(assignments || {})) {
    const raw = cacheEntryValue(value);
    if (!raw) continue;
    const norm = normalizeCacheValue(raw);
    if (!claimants.has(norm)) claimants.set(norm, []);
    claimants.get(norm).push(key);
  }
  const refused = [];
  const refusedKeys = [];
  for (const [key, value] of Object.entries(assignments || {})) {
    const raw = cacheEntryValue(value);
    const rivals = raw ? claimants.get(normalizeCacheValue(raw)).filter((k) => k !== key) : [];
    const owner = rivals.length > 0 ? rivals.join(',') : findConflictingKey(next, key, value);
    if (owner === null) {
      next[key] = value;
      continue;
    }
    refused.push({ key, value, owner });
    refusedKeys.push(key);
  }
  // Restore after every accepted assignment has claimed its value, so a
  // restored previous value can never take a slug a batch key just won.
  for (const key of refusedKeys) {
    if (Object.prototype.hasOwnProperty.call(previous, key)
        && findConflictingKey(next, key, previous[key]) === null) {
      next[key] = previous[key];
    }
  }
  return { map: next, refused };
}

/**
 * Every normalized value claimed by 2+ keys: [{ value, keys }]. `value` is the
 * raw value of the first claimant. Entries that claim nothing are skipped.
 * The audit-side twin of findConflictingKey (BRO-3517).
 */
function findDuplicateValues(map) {
  const byNormalized = new Map();
  for (const [key, entry] of Object.entries(map || {})) {
    const raw = cacheEntryValue(entry);
    if (!raw) continue;
    const norm = normalizeCacheValue(raw);
    if (!norm) continue;
    if (!byNormalized.has(norm)) byNormalized.set(norm, { value: raw, keys: [] });
    byNormalized.get(norm).keys.push(key);
  }
  return [...byNormalized.values()].filter((e) => e.keys.length > 1);
}

module.exports = {
  normalizeCacheValue,
  findDuplicateValues,
  cacheEntryValue,
  findConflictingKey,
  applyAssignmentsWithoutCollisions,
};
