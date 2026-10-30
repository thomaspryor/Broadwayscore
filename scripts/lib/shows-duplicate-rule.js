'use strict';
/**
 * The shows.json duplicate rule (BRO-6578). One copy, used by:
 *   - scripts/validate-shows-prebuild.js: fails the build on any finding;
 *   - scripts/lib/shows-write-guard.js: refuses a save that ADDS a finding;
 *   - scripts/lib/add-show-action.js: refuses an add-show row that would be one.
 *
 * Fast O(n) detection with hash indexes: exact title, slug, id base and
 * normalized title, same market only, confirmed by checkForDuplicate (which
 * knows multi-production and cross-link exemptions). Fuzzy matching runs at
 * ingestion time in discover-new-shows.js.
 *
 * Malformed rows (show-row-guard.js) are skipped, not thrown on: the write
 * guard runs this on raw data, where a title-less row must not block writes.
 */

const { checkForDuplicate, slugify, normalizeTitle } = require('./deduplication');
const { getMarketPool } = require('./venue-classification');
const { stripIdSuffix } = require('./market-slug');
const { partitionShowRows } = require('./show-row-guard');

// Express E2E test fixtures intentionally clone real titles.
const isTestFixture = (s) => /(^|-)express-test(-|$)/.test(s.id || '');

/** The four index keys a row is matched on; `norm` is null under 3 chars. */
function duplicateKeys(show) {
  const slug = show.slug || slugify(show.title);
  const norm = normalizeTitle(show.title);
  return { titleLower: show.title.toLowerCase().trim(), slug, idBase: stripIdSuffix(slug), norm: norm.length >= 3 ? norm : null };
}

/**
 * Rows that share an index key with `show` (well-formed rows only). The rule
 * only pairs rows that share a key, so findDuplicateShows([...near, show])
 * finds for `show` exactly what the full catalog would, at a fraction of the cost.
 */
function rowsSharingKey(rows, show) {
  if (!partitionShowRows([show]).valid.length) return [];
  const k = duplicateKeys(show);
  return partitionShowRows(rows || []).valid.filter((r) => {
    const rk = duplicateKeys(r);
    return rk.titleLower === k.titleLower || rk.slug === k.slug || rk.idBase === k.idBase || (k.norm && rk.norm === k.norm);
  });
}

/**
 * @param {Object[]} rows - shows.json rows, in file order.
 * @returns {{show: Object, existing: Object, reason: string}[]} one finding per
 *   flagged row; `show` is the later row in file order, `existing` the earlier.
 */
function findDuplicateShows(rows) {
  const shows = partitionShowRows(rows || []).valid.filter((s) => !isTestFixture(s));
  const findings = [];
  const titleIndex = new Map();  // lowercase title -> [shows]
  const slugIndex = new Map();   // slug -> [shows]
  const idBaseIndex = new Map(); // id base (no year/market suffix) -> [shows]
  const normIndex = new Map();   // normalized title -> [shows]

  const addToIndex = (index, key, show) => {
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(show);
  };

  for (const show of shows) {
    const { titleLower, slug, idBase, norm } = duplicateKeys(show);
    const market = getMarketPool(show.category);

    for (const [key, index] of [
      [titleLower, titleIndex],
      [slug, slugIndex],
      [idBase, idBaseIndex],
      [norm, normIndex],
    ]) {
      if (!key) continue;
      const candidates = index.get(key);
      if (!candidates) continue;
      const sameMarket = candidates.filter((c) => getMarketPool(c.category) === market);
      if (sameMarket.length === 0) continue;
      const check = checkForDuplicate(show, sameMarket);
      if (check.isDuplicate) {
        findings.push({ show, existing: check.existingShow, reason: check.reason });
        break; // One finding per show is enough
      }
    }

    addToIndex(titleIndex, titleLower, show);
    addToIndex(slugIndex, slug, show);
    addToIndex(idBaseIndex, idBase, show);
    if (norm) addToIndex(normIndex, norm, show);
  }
  return findings;
}

/** The prebuild's message for one finding. */
function formatFinding(f) {
  return `"${f.show.title}" (${f.show.id}) duplicates "${f.existing.title}" (${f.existing.id}) — ${f.reason}`;
}

const pairKey = (f) => [f.show.id, f.existing.id].sort().join('\u0000');

/**
 * Findings in `after` that `before` did not have. A pair counts as old when
 * `before` had it, or when `before` paired the same partner with a row that is
 * gone from `after` (an id rename inside a known pair is not a new duplicate).
 * @param {Object[]} before - rows as they were (e.g. on disk)
 * @param {Object[]} after - rows about to be written
 */
function newDuplicateFindings(before, after) {
  const found = findDuplicateShows(after);
  if (!found.length) return [];
  const old = findDuplicateShows(before);
  const oldKeys = new Set(old.map(pairKey));
  const afterIds = new Set((after || []).map((s) => s && s.id));
  const goneFrom = new Map(); // partner id -> true when its old pair-mate left
  for (const f of old) {
    if (!afterIds.has(f.show.id)) goneFrom.set(f.existing.id, true);
    if (!afterIds.has(f.existing.id)) goneFrom.set(f.show.id, true);
  }
  return found.filter((f) => !oldKeys.has(pairKey(f)) && !goneFrom.has(f.show.id) && !goneFrom.has(f.existing.id));
}

module.exports = { findDuplicateShows, newDuplicateFindings, formatFinding, isTestFixture, rowsSharingKey };
