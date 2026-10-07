/**
 * Detect commercial.json entries keyed by show ID that duplicate a
 * slug-keyed sibling entry — the double-counted-pair class behind the
 * 2026-08-01 "Commercial model drift" alert (13 ID-keyed entries,
 * resurrected by an opening-night-poller clobber, inflated every
 * commercial audit metric for 13 days while only warranting a generic
 * medium-severity id-mismatch).
 *
 * The predicate is deliberately shows.json-backed, NOT a "-YYYY suffix"
 * string heuristic: mamma-mia-2001 and ragtime-2009 are legitimate SLUGS
 * of distinct productions (separate from the current mamma-mia/ragtime
 * revivals) and must never match. Never string-strip years.
 */

/**
 * A key is the ID half of a duplicate pair only when all three hold:
 *   1. the key is not any show's slug,
 *   2. the key IS a show's id,
 *   3. that show's slug is ALSO a key in commercialShows.
 *
 * @param {object} commercialShows - commercial.json's `shows` map
 * @param {object} showBySlug - shows.json entries keyed by slug
 * @param {object} showById - shows.json entries keyed by id
 * @returns {Array<{idKey: string, slugKey: string}>}
 */
function findDuplicateKeyPairs(commercialShows, showBySlug, showById) {
  const pairs = [];
  for (const key of Object.keys(commercialShows)) {
    if (showBySlug[key]) continue;
    const show = showById[key];
    if (!show) continue;
    // Defense-in-depth: shows like mamma-mia-2001 have id === slug, so clause
    // 1 already excludes them — but if that clause ever regressed, a self-pair
    // here would let --apply delete the show's ONLY entry. Never self-pair.
    if (show.slug === key) continue;
    if (!(show.slug in commercialShows)) continue;
    pairs.push({ idKey: key, slugKey: show.slug });
  }
  return pairs;
}

/**
 * Fields the recoupment model re-stamps on every run — a difference here
 * never represents human-entered data, so these are ignored when deciding
 * whether an ID-keyed entry holds anything its slug sibling lacks.
 */
function isModelStampedField(field) {
  return /^model/.test(field) || field === 'lastUpdated';
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Containment: deep-equal, or an array whose every element appears in the
 * slug entry's array. Substring containment applies ONLY to `notes` (the Jul
 * 19 merge concatenated notes, keeping the original text as a substring) —
 * for any other string field a prefix match would silently discard a
 * genuinely different value (e.g. a recoupedSource URL that happens to be a
 * prefix of the slug entry's). */
function contained(field, idValue, slugValue) {
  if (deepEqual(idValue, slugValue)) return true;
  if (Array.isArray(idValue) && Array.isArray(slugValue)) {
    return idValue.every((x) => slugValue.some((y) => deepEqual(x, y)));
  }
  if (field === 'notes' && typeof idValue === 'string' && typeof slugValue === 'string') {
    return slugValue.includes(idValue);
  }
  return false;
}

/**
 * Which non-model fields of the ID-keyed entry are NOT contained in the
 * slug-keyed entry. Empty result = deleting the ID key loses nothing.
 * Non-empty = the entries disagree; in a clobber-resurrection the slug
 * entry carries the later adjudication, but the caller must decide.
 *
 * @returns {string[]} conflicting field names
 */
function conflictingFields(idEntry, slugEntry) {
  return Object.keys(idEntry)
    .filter((f) => !isModelStampedField(f))
    .filter((f) => !contained(f, idEntry[f], slugEntry[f]));
}

/**
 * Fields an ID-keyed duplicate may disagree on and still be dropped in
 * favour of its slug sibling WITHOUT --prefer-slug (BRO-4623 item 4).
 *
 * Every ID-keyed entry is, by construction, a write that went to the wrong
 * key (commercial.json is slug-keyed; ID keys never render on /biz). When
 * what it holds beyond the slug entry is only commentary or bookkeeping,
 * the slug entry is the record of truth and deleting the ID key loses no
 * published data. The 2026-10-03 weekly publish was blocked by exactly this
 * shape: the-balusters-2026 and school-girls-or-the-african-mean-girls-
 * play-2026 (both "Nonprofit" like their slug entries) differed only in an
 * AI-written note, a source list and firstAdded. Their sources were NOT
 * merged in: the-balusters-2026's list cites an unrelated company's SEC
 * exhibit (ufpi-20260730xex99d1.htm), and appending AI notes would put
 * duplicate prose on the public show page. The discarded values are printed
 * by the caller, so the run log keeps them.
 *
 * Anything substantive (capitalization, recouped, recoupedDate,
 * recoupedSource, a real designation, ...) still refuses, as before.
 */
const SELF_HEAL_FIELDS = new Set([
  'notes', 'sources', 'firstAdded',
  // deep-research attempt bookkeeping on a stub it wrote under the wrong key
  'researchAttempts', 'lastResearchedAt', 'researchTrigger',
]);

/**
 * @param {object} idEntry
 * @param {object} slugEntry
 * @param {string[]} [conflicts] - conflictingFields(idEntry, slugEntry), recomputed when omitted
 * @returns {boolean} true when the pair can be resolved by keeping the slug entry as-is
 */
function isSelfHealablePair(idEntry, slugEntry, conflicts) {
  const fields = conflicts || conflictingFields(idEntry, slugEntry);
  if (fields.length === 0) return true;
  return fields.every((f) => {
    if (SELF_HEAL_FIELDS.has(f)) return true;
    // A placeholder "TBD" on the ID key says nothing the slug entry lacks.
    if (f === 'designation') return idEntry.designation === 'TBD' || idEntry.designation == null;
    return false;
  });
}

module.exports = { findDuplicateKeyPairs, conflictingFields, isModelStampedField, isSelfHealablePair, SELF_HEAL_FIELDS };
