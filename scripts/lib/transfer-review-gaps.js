'use strict';
/**
 * Pure decision functions for scripts/audit-transfer-review-gaps.js (BRO-1361), kept in scripts/lib so
 * the test requires the real functions (CLAUDE.md section 15) and CI path filters that already cover
 * scripts/lib apply. No I/O here.
 */
const { parseDate } = require('./date-utils');
const { foldDiacritics } = require('./title-match');
const { sanitizeVenueForWrite } = require('./venue-classification');

const DAY_MS = 86400000;


// Perpetual rotating-repertory companies stage the SAME titles indefinitely
// at ONE venue (no transfer ever happens — there is no "prior venue" to
// declare). Real-data run (BRO-1361) surfaced this at Repertorio Español
// (la-gringa-off-broadway-2026, running "La Gringa" in rotation since 1996 —
// 30th-anniversary press, not a new production) — kept as a cheap, always-on
// exclusion for that specific company.
const PERPETUAL_REPERTORY_VENUES = [/repertorio\s+espa[nñ]ol/i];

function isPerpetualRepertoryVenue(venue) {
  if (!venue) return false;
  return PERPETUAL_REPERTORY_VENUES.some((re) => re.test(venue));
}

function normalizeVenueForRepertoryCheck(venue) {
  return foldDiacritics(venue || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// General structural version of the same guard (ship-check finding — a
// hardcoded venue allowlist doesn't generalize): the Metropolitan Opera House
// re-stages "La Bohème" / "Madama Butterfly" annually at the SAME venue —
// same-title, same-venue re-mountings, exactly the rotating-repertory shape,
// with no hardcoded venue list needed. If a same-title sibling shares this
// show's exact venue, it's a repeat mounting at the SAME house, not a
// transfer TO a different one — there is no "prior venue" to declare.
// @param {object} show
// @param {Array<object>} sameTitleShows
// @returns {boolean}
function hasSameVenueSibling(show, sameTitleShows) {
  const showVenue = normalizeVenueForRepertoryCheck(show.venue);
  if (!showVenue) return false;
  return sameTitleShows.some((sib) => sib && sib.id !== show.id && normalizeVenueForRepertoryCheck(sib.venue) === showVenue);
}

/**
 * Pure eligibility check: is this show a candidate worth investigating?
 * Off-Broadway, currently running (previews/open), no reviews at all, no
 * priorRuns already declared, and old enough for reviews to plausibly exist
 * but not so old it's just an obscure unreviewed run.
 * @param {object} show
 * @param {number} reviewCount
 * @param {Date} now
 * @param {{minDaysOpen: number, windowDays: number}} opts
 * @param {Array<object>} [sameTitleShows]  other shows sharing show's normalized title, for the same-venue repertory guard
 * @returns {{eligible: boolean, daysSinceOpen: number|null}}
 */
function isEligibleCandidate(show, reviewCount, now, opts, sameTitleShows = []) {
  const { minDaysOpen, windowDays } = opts;
  if (!show || !show.id) return { eligible: false, daysSinceOpen: null };
  if (show.category !== 'off-broadway') return { eligible: false, daysSinceOpen: null };
  if (!['previews', 'open'].includes(show.status)) return { eligible: false, daysSinceOpen: null };
  if (isPerpetualRepertoryVenue(show.venue)) return { eligible: false, daysSinceOpen: null };
  if (hasSameVenueSibling(show, sameTitleShows)) return { eligible: false, daysSinceOpen: null };
  if (reviewCount > 0) return { eligible: false, daysSinceOpen: null };
  if (Array.isArray(show.priorRuns) && show.priorRuns.length > 0) {
    return { eligible: false, daysSinceOpen: null };
  }
  const recency = parseDate(show.openingDate || show.previewsStartDate);
  if (!recency || isNaN(recency.getTime())) return { eligible: false, daysSinceOpen: null };
  const daysSinceOpen = Math.round((now.getTime() - recency.getTime()) / DAY_MS);
  const eligible = daysSinceOpen >= minDaysOpen && daysSinceOpen <= windowDays;
  return { eligible, daysSinceOpen };
}

// A genuine transfer's prior run ended shortly before the new venue's run
// began — the whole point of a transfer is continuity. A same-title sibling
// years earlier (a Broadway revival's original run, a different production
// entirely) is a title COLLISION, not a prior run — same class of false
// positive detect-venue-transfers.js guards against with SPAN_TIGHT_DAYS.
// "Matilda the Musical" 2013 Broadway (Shubert) vs. a 2026 Off-Broadway
// "Theatre Row" revival is exactly this: same title, unrelated productions.
const MAX_SIBLING_GAP_DAYS = 730;

/**
 * Find the best same-title sibling entry that plausibly houses this
 * candidate's "missing" earlier run: a DIFFERENT show id, same normalized
 * title, an earlier opening (or previews) date within MAX_SIBLING_GAP_DAYS
 * of the candidate's opening, and at least one review. Ties broken by
 * picking the LATEST-opening sibling before the candidate (the run most
 * likely immediately prior to the transfer).
 * @param {object} show
 * @param {Array<object>} sameTitleShows  all shows sharing show's normalized title (excluding show itself)
 * @param {Map<string, number>} reviewCounts
 * @returns {object|null}
 */
function findSiblingCandidate(show, sameTitleShows, reviewCounts) {
  const candidateOpen = parseDate(show.openingDate || show.previewsStartDate);
  if (!candidateOpen) return null;
  let best = null;
  let bestOpen = null;
  for (const sib of sameTitleShows) {
    if (!sib || sib.id === show.id) continue;
    // Cross-market/category title collision guard (ship-check finding): a
    // same-title West End production is NOT a prior run of an Off-Broadway
    // candidate — same class of false positive detect-venue-transfers.js
    // excludes via its own marketMatch check.
    if (sib.category !== show.category) continue;
    const sibOpen = parseDate(sib.openingDate || sib.previewsStartDate);
    if (!sibOpen || isNaN(sibOpen.getTime())) continue;
    if (sibOpen.getTime() >= candidateOpen.getTime()) continue; // must be earlier
    // Anchor the gap on the sibling's LATEST known date (closing if known,
    // else opening) — a long-running earlier production that closed shortly
    // before the transfer is still a tight gap even if it opened years ago.
    const sibClose = parseDate(sib.closingDate);
    const hasClose = !!(sibClose && !isNaN(sibClose.getTime()));
    // A sibling with no closing date that is not marked closed is still running (or its end is
    // unknown): it cannot be the finished earlier run of a transfer, so never suggest it.
    if (!hasClose && sib.status !== 'closed') continue;
    const sibEnd = hasClose ? sibClose : sibOpen;
    // A genuine prior run must have actually ENDED before the candidate
    // opened (ship-check finding: anchoring only on sibOpen let a sibling
    // that closed AFTER the candidate's opening — i.e. still running,
    // overlapping/concurrent, a different concurrent production — produce a
    // NEGATIVE gap that trivially passed the "gap > MAX" rejection below).
    if (sibEnd.getTime() > candidateOpen.getTime()) continue;
    const gapDays = (candidateOpen.getTime() - sibEnd.getTime()) / DAY_MS;
    if (gapDays > MAX_SIBLING_GAP_DAYS) continue; // title collision, not a transfer
    const count = reviewCounts.get(sib.id) || 0;
    if (count <= 0) continue;
    if (!best || sibOpen.getTime() > bestOpen.getTime()) {
      best = sib;
      bestOpen = sibOpen;
    }
  }
  return best;
}

function buildSuggestedPriorRun(sibling, reviewCounts) {
  return {
    venue: sanitizeVenueForWrite(sibling.venue || ''),
    openingDate: sibling.openingDate || sibling.previewsStartDate || null,
    closingDate: sibling.closingDate || null,
    note: `Auto-detected sibling entry ${sibling.id} (${reviewCounts.get(sibling.id) || 0} review(s)) — confirm this is the SAME production before adding priorRuns.`,
  };
}

module.exports = { DAY_MS, MAX_SIBLING_GAP_DAYS, isEligibleCandidate, findSiblingCandidate, buildSuggestedPriorRun, isPerpetualRepertoryVenue, hasSameVenueSibling };
