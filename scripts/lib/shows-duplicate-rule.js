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
 * Check a completed candidate before adding it to a batch (BRO-6591).
 * Include earlier accepted candidates in rows so duplicates within the batch
 * are skipped too. Existing findings must never reject an unrelated candidate.
 * Returns the same finding as the prebuild rule, or null; does not mutate rows.
 */
function duplicateOfCandidate(rows, show) {
  return findDuplicateShows([...rowsSharingKey(rows, show), show])
    .find(f => f.show === show) || null;
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
 * `before` had it, or when one side is a row `before` did not have and its
 * partner's old pair-mate is gone from `after` (an id rename inside a known
 * pair). Two rows that were both on disk and not paired are always new.
 * @param {Object[]|function(): Object[]} before - rows as they were (e.g. on
 *   disk); a function is only called when `after` has findings at all
 * @param {Object[]} after - rows about to be written
 */
function newDuplicateFindings(before, after) {
  const found = findDuplicateShows(after);
  if (!found.length) return [];
  if (typeof before === 'function') before = before();
  const old = findDuplicateShows(before);
  const oldKeys = new Set(old.map(pairKey));
  const afterIds = new Set((after || []).map((s) => s && s.id));
  const beforeIds = new Set((before || []).map((s) => s && s.id));
  const goneFrom = new Map(); // partner id -> true when its old pair-mate left
  for (const f of old) {
    if (!afterIds.has(f.show.id)) goneFrom.set(f.existing.id, true);
    if (!afterIds.has(f.existing.id)) goneFrom.set(f.show.id, true);
  }
  const renamed = (f) => (!beforeIds.has(f.show.id) && goneFrom.has(f.existing.id))
    || (!beforeIds.has(f.existing.id) && goneFrom.has(f.show.id));
  return found.filter((f) => !oldKeys.has(pairKey(f)) && !renamed(f));
}

// Words too common to narrow the neighbourhood a new row is compared with.
const FRAGMENT_STOP = new Set(['the', 'and', 'for', 'with', 'musical', 'play', 'new', 'off', 'broadway', 'west', 'end']);
const fragmentWords = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !FRAGMENT_STOP.has(w));

/**
 * BRO-7080 (replay of BRO-4503 / BRO-5557): rows NEW in `after` whose title is
 * a fragment of an existing row's at the same venue or room with overlapping
 * dates ("Motherfucker" @ Soho Playhouse Main Stage beside "Jena Friedman:
 * Motherfucker" @ SoHo Playhouse; "Matthew Bourne's Cinderella" beside
 * "Matthew Bourne's New Adventures - Cinderella"). The key-index rule above
 * never pairs them (no shared exact/slug/id/normalized title), so the save
 * guard let promoters that bypass add-show-action write them, and only the
 * daily audit caught the split reviews days later. Same detector as
 * add-show-action.newRowDuplicate. A pair either row lists in distinctFrom is
 * a declared distinct production. Dry run 2026-11-09: 0 hits across the 843
 * live (announced/upcoming/previews/open) rows.
 * @returns {{show: Object, existing: Object, reason: string}[]}
 */
function newRowFragmentFindings(before, after) {
  const { findTitleFragmentDupes } = require('./show-duplicate-detection');
  const rows = partitionShowRows(after || []).valid.filter((s) => !isTestFixture(s));
  if (typeof before === 'function') before = before();
  const beforeIds = new Set((before || []).map((s) => s && s.id));
  // Nothing on disk (a fresh file) is not "adding" every row; the prebuild rule covers it.
  if (!beforeIds.size) return [];
  const added = rows.filter((s) => !beforeIds.has(s.id));
  if (!added.length) return [];
  const byWord = new Map();
  for (const r of rows) for (const w of new Set(fragmentWords(r.title))) {
    if (!byWord.has(w)) byWord.set(w, []);
    byWord.get(w).push(r);
  }
  const out = [];
  for (const show of added) {
    const declared = new Set(Array.isArray(show.distinctFrom) ? show.distinctFrom : []);
    const near = new Set();
    for (const w of new Set(fragmentWords(show.title))) for (const r of byWord.get(w) || []) if (r !== show) near.add(r);
    for (const other of near) {
      if (declared.has(other.id) || (Array.isArray(other.distinctFrom) && other.distinctFrom.includes(show.id))) continue;
      if (getMarketPool(other.category) !== getMarketPool(show.category)) continue;
      const hit = findTitleFragmentDupes([show, other])[0];
      if (hit) { out.push({ show, existing: other, reason: 'title fragment at the same venue with overlapping dates' }); break; }
    }
  }
  return out;
}

module.exports = { findDuplicateShows, newDuplicateFindings, newRowFragmentFindings, duplicateOfCandidate, formatFinding, isTestFixture, rowsSharingKey };
