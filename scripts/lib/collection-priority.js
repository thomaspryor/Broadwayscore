'use strict';

/**
 * Collection-queue ordering for collect-review-texts.js.
 *
 * Extracted so the ordering rule is testable against real corpus shapes
 * (CLAUDE.md §15) rather than only exercised through a 6,000-line script.
 *
 * The defect this module exists to prevent
 * ---------------------------------------
 * The queue is sorted by show recency, descending. The recency key used to be
 * `show.openingDate || '1900-01-01'`. A show with a null openingDate therefore
 * sorted BEHIND every dated show in a ~2,800-show corpus. Scheduled runs cap at
 * max_reviews=300, so those reviews were never reached — not deprioritised,
 * never collected at all.
 *
 * Observed 2026-08-12: every live show with a real openingDate collected
 * normally (The Vessel 6/6, The Pass 8/10, Disruption 20/35, Cats 47/100) while
 * both live shows with openingDate=null collected ZERO (The Winter's Tale 0/11,
 * An American Daughter 0/9) despite having NYT/Vulture reviews already
 * discovered and sitting at contentTier=stub, incompleteReason=not_attempted.
 *
 * A show in previews has not opened yet, but its reviews are the most
 * time-critical in the corpus — press night is exactly when the score has to
 * exist. previewsStartDate must therefore rank it alongside its peers.
 */

/** Sentinel for a show we have no date of any kind for. Sorts last, by design. */
const NO_DATE_SENTINEL = '1900-01-01';

/**
 * Best-known recency date for a show, for queue ordering only.
 *
 * Never returns null/undefined/'' — the comparator calls localeCompare on the
 * result, and an empty string would silently reintroduce the same
 * sorts-behind-everything bug this module was written to kill.
 *
 * @param {{openingDate?: string|null, previewsStartDate?: string|null}} show
 * @returns {string} YYYY-MM-DD, or NO_DATE_SENTINEL
 */
function showRecencyKey(show) {
  if (!show || typeof show !== 'object') return NO_DATE_SENTINEL;
  return show.openingDate || show.previewsStartDate || NO_DATE_SENTINEL;
}

/**
 * showId → recency key, for every show that has any usable date.
 *
 * @param {Array} shows raw shows.json entries
 * @returns {Map<string,string>}
 */
function buildShowRecencyMap(shows) {
  const map = new Map();
  for (const show of shows || []) {
    if (!show || !show.id) continue;
    const key = showRecencyKey(show);
    if (key !== NO_DATE_SENTINEL) map.set(show.id, key);
  }
  return map;
}

/**
 * Queue comparator: open/preview shows first, then newest show first, then
 * never-attempted before previously-attempted, then by outlet tier.
 *
 * @param {object} a queue entry
 * @param {object} b queue entry
 * @param {{closedShowMode?: boolean}} opts
 * @returns {number}
 */
function compareReviewPriority(a, b, { closedShowMode = false } = {}) {
  if (!closedShowMode && a.isOpenShow !== b.isOpenShow) {
    return a.isOpenShow ? -1 : 1;
  }
  // Newest shows first — a show that opened last night outranks one from 2003.
  if (a.recencyDate !== b.recencyDate) {
    return String(b.recencyDate).localeCompare(String(a.recencyDate));
  }
  // Never-attempted before previously-attempted.
  const aAttempted = a.fetchAttempts > 0 ? 1 : 0;
  const bAttempted = b.fetchAttempts > 0 ? 1 : 0;
  if (aAttempted !== bAttempted) return aAttempted - bAttempted;
  return a.priority - b.priority;
}

module.exports = {
  NO_DATE_SENTINEL,
  showRecencyKey,
  buildShowRecencyMap,
  compareReviewPriority,
};
