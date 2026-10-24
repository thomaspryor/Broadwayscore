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

/**
 * Per-run slots for textless needsRefetch reviews (BRO-4426).
 *
 * A review whose fullText was cleared (URL-change clear) carries needsRefetch
 * but ranks by its SHOW's recency, so on a closed show it sat past the
 * max_reviews cut run after run (238 shipped reviews textless, oldest ~7
 * months). Nothing else queues them. These slots pull the cheapest-tier ones
 * to the front of every scheduled run; the cap keeps the paid-fetch spend
 * bounded and the rest wait for the next run.
 */
const NEEDS_REFETCH_DRAIN_PER_RUN = 25;
const NEEDS_REFETCH_MIN_TEXT = 200;

/** True for a review that was told to refetch and holds no usable body. */
function isTextlessNeedsRefetch(data) {
  if (!data || data.needsRefetch !== true) return false;
  const len = typeof data.fullText === 'string' ? data.fullText.length : 0;
  return len <= NEEDS_REFETCH_MIN_TEXT;
}

/** Fetch failures after which a refetch slot is wasted (dead URL, wall, mismatch). */
const NEEDS_REFETCH_MAX_FAILURES = 3;

/**
 * True when a textless needsRefetch review deserves a reserved slot: no usable
 * body, not protected, and not already failed repeatedly. The first 5-review CI
 * test (2026-10-14) spent every slot on Variety/Vulture URLs with 48 recorded
 * url_dead_404 failures; those need URL rediscovery, not another fetch.
 *
 * @param {object} data review file JSON
 * @param {{failureCount?: number}|null} ledgerEntry failed-fetches.json row
 */
function isNeedsRefetchDrainCandidate(data, ledgerEntry) {
  if (!isTextlessNeedsRefetch(data)) return false;
  if (data._locked === true || data.manualContentTier === 'complete') return false;
  const fileFails = Array.isArray(data.fetchAttempts) ? data.fetchAttempts.length : 0;
  const ledgerFails = ledgerEntry && Number.isFinite(ledgerEntry.failureCount) ? ledgerEntry.failureCount : 0;
  return Math.max(fileFails, ledgerFails) < NEEDS_REFETCH_MAX_FAILURES;
}

/** Run bucket: the collect cron fires 3x/day, so each 8h window rotates the draw. */
function drainRotationSeed(nowMs = Date.now()) {
  return Math.floor(nowMs / (8 * 3600 * 1000));
}

function rotationHash(id, seed) {
  // FNV-1a over `${seed}|${id}`: stable for one run, reshuffled for the next.
  let h = 0x811c9dc5;
  const str = `${seed}|${id}`;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * Move up to `cap` textless needsRefetch entries (flag `_needsRefetch`) to the
 * front of an already-sorted queue. WHICH ones rotate with `seed`: a review that
 * cannot be fixed by a fetch (wrong url, SERP finds nothing) records no failure,
 * so a fixed ordering would hand it the same slot every run and starve the rest
 * (seen in the 2026-10-14 CI test: Wicked/Romeo and Juliet urls on the wrong
 * show took all 5 slots twice). Entries past the cap keep their normal position.
 * Returns a new array; does not mutate the input.
 */
function promoteNeedsRefetch(queue, cap = NEEDS_REFETCH_DRAIN_PER_RUN, seed = drainRotationSeed()) {
  const flagged = [];
  queue.forEach((r, i) => { if (r && r._needsRefetch) flagged.push({ r, i }); });
  if (!flagged.length || cap <= 0) return queue.slice();
  flagged.sort((a, b) => (rotationHash(a.r.reviewId || a.i, seed) - rotationHash(b.r.reviewId || b.i, seed)) || (a.i - b.i));
  const chosen = flagged.slice(0, cap).map(f => f.r);
  const promoted = new Set(chosen);
  return [...chosen, ...queue.filter(r => !promoted.has(r))];
}

/**
 * Per-run slots for aged never-attempted stubs (BRO-6123).
 *
 * Queue order is show recency, so a closed show's freshly created stubs (the
 * theatre.reviews reconcile wrote ~1,160 West End files in one night, BRO-6084)
 * rank behind every open show and past the max_reviews cut, run after run: 176
 * files with a URL sat at fetchAttempts 0 through the 04:30 and 10:30 runs.
 * These slots pull the oldest of them to the front; the cap bounds paid-fetch
 * spend (each slot is one normal fetch, same fetch gate and cooldowns as any
 * other queue entry) and the remainder waits for the next run.
 */
const AGED_STUB_DRAIN_PER_RUN = 40;
const AGED_STUB_MIN_AGE_HOURS = 48;

/**
 * True for a queued review that has a URL, was never fetched, and has been
 * sitting that way for at least `minAgeHours`. A file with no usable
 * firstSeenAt counts as aged: an unknown age must not hide a stub from the
 * drain.
 *
 * @param {object} data review file JSON
 * @param {{minAgeHours?: number, nowMs?: number}} opts
 * @returns {boolean}
 */
function isAgedNeverAttemptedStub(data, { minAgeHours = AGED_STUB_MIN_AGE_HOURS, nowMs = Date.now() } = {}) {
  if (!data || typeof data.url !== 'string' || !data.url) return false;
  // The collector's own marker for "Has URL but never scraped". Without it the
  // predicate matched 44k of 60k files (null/absent fetchAttempts is the norm).
  if (data.incompleteReason !== 'not_attempted') return false;
  if (typeof data.fullText === 'string' && data.fullText.length > 0) return false;
  if (Array.isArray(data.fetchAttempts) ? data.fetchAttempts.length > 0 : Number(data.fetchAttempts) > 0) return false;
  if (data._locked === true || data.manualContentTier === 'complete') return false;
  const seen = Date.parse(data.firstSeenAt);
  if (!Number.isFinite(seen)) return true;
  return nowMs - seen >= minAgeHours * 3600 * 1000;
}

/**
 * Move up to `cap` entries flagged `_agedStub` to the front of an
 * already-sorted queue. WHICH ones rotate with `seed` (same reasoning as
 * promoteNeedsRefetch): a fetch that fails writes its verdict to the ledger,
 * not to the file's fetchAttempts, and most backlog files carry no firstSeenAt,
 * so any fixed ordering would hand the same 40 files the slots every run. Entries
 * past the cap keep their normal position. Returns a new array; does not
 * mutate the input.
 */
function promoteAgedStubs(queue, cap = AGED_STUB_DRAIN_PER_RUN, seed = drainRotationSeed()) {
  const flagged = [];
  queue.forEach((r, i) => { if (r && r._agedStub) flagged.push({ r, i }); });
  if (!flagged.length || cap <= 0) return queue.slice();
  flagged.sort((a, b) => (rotationHash(a.r.reviewId || a.i, seed) - rotationHash(b.r.reviewId || b.i, seed)) || (a.i - b.i));
  const chosen = flagged.slice(0, cap).map(f => f.r);
  const promoted = new Set(chosen);
  return [...chosen, ...queue.filter(r => !promoted.has(r))];
}

module.exports = {
  AGED_STUB_DRAIN_PER_RUN,
  AGED_STUB_MIN_AGE_HOURS,
  isAgedNeverAttemptedStub,
  promoteAgedStubs,
  NEEDS_REFETCH_DRAIN_PER_RUN,
  isTextlessNeedsRefetch,
  isNeedsRefetchDrainCandidate,
  NEEDS_REFETCH_MAX_FAILURES,
  promoteNeedsRefetch,
  drainRotationSeed,
  NO_DATE_SENTINEL,
  showRecencyKey,
  buildShowRecencyMap,
  compareReviewPriority,
};
