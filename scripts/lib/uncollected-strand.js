'use strict';

const { datesFromDiscoveredReviews } = require('./opening-signal');
const { toDateMs } = require('./date-utils');

/**
 * Date-independent detection of review URLs we discovered and then never fetched.
 *
 * Why this is separate from every other coverage monitor
 * -----------------------------------------------------
 * Every existing coverage check keys off a show's opening window, so all of
 * them share one failure mode: a show whose date field is null drops out of
 * scope silently, and a check that never runs never fails. On 2026-08-12 that
 * cost two Off-Broadway openings their entire review sets — The Winter's Tale
 * (11 discovered URLs, 0 collected) and An American Daughter (9 discovered, 0
 * collected) — with a live NYT review, a Playbill Verdict article and a BWW
 * roundup all pointing at them, and not one alert anywhere. The collection
 * queue sorted them behind 2,800 shows and the gap audit skipped them, both
 * for the same reason: `openingDate` was null.
 *
 * So the STRAND half of this module deliberately reads no date field of the
 * show. Its question is only: "we wrote down a URL for a live show — did we
 * ever fetch it?" A check that depends on no date cannot be silenced by a
 * missing one, and that is the part that must never regress.
 *
 * The totalBlackout ESCALATION is different and does consult dates, because
 * "this show has no critics at all" is only alarming once press night has
 * happened. It reads show.status/openingDate first and falls back to review
 * dates, so a null openingDate alone cannot silence it — but a show wrongly
 * marked `previews` with a late previewsStartDate can. That residual exposure
 * is deliberate and bounded: the strand list still fires underneath it.
 *
 * `incompleteReason: 'not_attempted'` is the collector's own marker for
 * "Has URL but never scraped", so it is exact rather than inferred.
 */

/** Live statuses whose reviews are supposed to be on the site right now. */
const LIVE_STATUSES = new Set(['open', 'previews']);

/**
 * Hours a discovered URL may sit unfetched before it counts as stranded.
 *
 * 12h ≈ 1.5 cycles of the 3×-daily collector (04:30/10:00/18:00 UTC): long
 * enough that ordinary queue latency is not an alert, short enough that a
 * blackout is caught the morning after press night rather than a day later.
 * A 24h default would not have flagged The Winter's Tale on the night the
 * owner found it by eye — its reviews were 14h old.
 */
const DEFAULT_MAX_AGE_HOURS = 12;

/**
 * True when this review file is a URL we discovered and never fetched.
 *
 * Deliberately narrow: files that carry a rejection/exclusion verdict were
 * looked at and judged, which is a decision, not a strand. Only 'not_attempted'
 * means nothing ever tried.
 *
 * @param {object} review parsed review-text JSON
 * @returns {boolean}
 */
function isNeverAttempted(review) {
  if (!review || typeof review !== 'object') return false;
  if (!review.url) return false;
  if ((review.fullText || '').length > 0) return false;
  return review.incompleteReason === 'not_attempted';
}

/**
 * True when a never-attempted file carries a terminal verdict that means it is
 * NOT supposed to be fetched, so leaving it unfetched is correct, not a strand.
 *
 * BRO-3719: 31 of the 32 "uncollected live review strands" on 2026-10-15 were
 * duplicate pointers. When a second file for the same URL is written (e.g.
 * `thestage--unknown.json` beside `thestage--matt-barton.json`), the writer
 * stamps `duplicateOf` and collect-review-texts.js deliberately skips it
 * (`skippedDuplicateOf`): the canonical sibling owns the fetch. The tombstone
 * keeps `incompleteReason: 'not_attempted'` forever, so isNeverAttempted alone
 * reported it as stranded every hour with no pipeline step able to clear it.
 *
 * A duplicate only counts as resolved when its pointer chain ends at a file
 * that exists in the same show folder and is not itself a duplicate. If that
 * canonical was never fetched either, the canonical is itself reported as a
 * strand, so the URL stays visible exactly once. A dangling pointer (canonical
 * missing) or a pointer cycle is still a strand: nothing owns that URL, and a
 * broken pointer must not buy an exemption.
 *
 * The other verdicts are the explicit non-review rejections ("looked at and
 * judged", per the isNeverAttempted doc). wrongProduction/wrongShow are left
 * out on purpose: those can be fallible pre-fetch guesses, and the strand list
 * is the backstop that must keep showing them.
 *
 * @param {object} review parsed review-text JSON
 * @param {Map<string, object>} siblings filename -> parsed review, same show folder
 * @returns {boolean}
 */
function hasTerminalVerdict(review, siblings) {
  if (!review || typeof review !== 'object') return false;
  // Only the explicit non-review verdict: wrong_show/wrong_production/garbage_text
  // can be fallible pre-fetch guesses and must stay visible.
  if (review.rejectionReason === 'not_a_review') return true;
  if (review.isNonReview === true || review.isNotReview === true) return true;
  return duplicateHasCanonical(review, siblings);
}

function duplicateHasCanonical(review, siblings) {
  const seen = new Set();
  let ptr = review.duplicateOf;
  while (typeof ptr === 'string' && ptr) {
    if (seen.has(ptr) || !siblings || !siblings.has(ptr)) return false;
    seen.add(ptr);
    const next = siblings.get(ptr);
    if (!next || !next.duplicateOf) return true;
    ptr = next.duplicateOf;
  }
  return false;
}

/**
 * True when a discovered file is a verdict about a DIFFERENT production than
 * the one this show record tracks, so it can't be evidence of a blackout.
 *
 * BRO-5077: a touring production (All the Devils Are Here, tour 2024) inherits
 * every Broadway-aggregator URL for the earlier NYC run; all were rejected as
 * wrongProduction (correctly) and the alarm paged for 0 usable of 5 discovered.
 * Two cases are safe to discount; the LLM-only verdict on a non-tour is NOT
 * (it is fallible, and a wrongly flagged real review set is exactly the
 * blackout this alarm exists to catch):
 *  - the deterministic date guards (pre-window / URL date before the show's
 *    earliest date), which never judge content, and
 *  - on a tour only, a wrongProduction file published >60d before the tour
 *    opened, or whose verdict says it reviews the earlier NYC run. A bare
 *    wrongProduction flag is NOT enough: real local tour reviews get that
 *    flag too and must still page when they are all that was discovered.
 *
 * @param {object} show
 * @param {object} review
 * @returns {boolean}
 */
function isOtherProductionEvidence(show, review) {
  if (!review || review.wrongProduction !== true) return false;
  const note = [review.wrongProductionNote, review.incompleteDetail, review.contentTierReason]
    .filter(Boolean).join(' ');
  if (/pre-window date|URL date .* days before show earliest date/i.test(note)) return true;
  if (!show || (show.market !== 'tour' && show.category !== 'tour')) return false;
  // Tour only. Local tour reviews are also LLM-flagged wrongProduction at times
  // (and-juliet-tour-2024, mrs-doubtfire-tour-2025), so a bare flag proves
  // nothing; require positive evidence the file is about the earlier run.
  const pub = toDateMs(review.publishDate);
  const open = toDateMs(show.openingDate);
  if (!Number.isNaN(pub) && !Number.isNaN(open) && pub < open - 60 * 86400000) return true;
  return /\b(original|earlier|prior|previous|off-)?\s*(Broadway|Off-Broadway|New York|NYC)\b[^.]{0,40}\b(production|run)\b/i.test(note)
    && /original|earlier|prior|previous|ran\b/i.test(note);
}

/**
 * Age in hours of a discovered-but-unfetched file, or null if undatable.
 *
 * @param {object} review
 * @param {number} nowMs
 * @returns {number|null}
 */
function strandAgeHours(review, nowMs) {
  const seen = review && review.firstSeenAt;
  if (!seen) return null;
  const t = Date.parse(seen);
  if (Number.isNaN(t)) return null;
  return (nowMs - t) / 3600000;
}

/**
 * Has this show's press night demonstrably happened?
 *
 * Two independent kinds of evidence, strongest first:
 *  1. The show record itself says `open` and its openingDate has arrived. This
 *     is the authoritative statement and needs no review data at all.
 *  2. A clean discovered review carries a date on/after previews began and that
 *     date has arrived.
 *
 * (2) alone is not enough, and assuming it was is how the first cut of this
 * function went wrong. Measured on the live corpus 2026-08-13: 95 of 99
 * `not_attempted` files carry no parseable date, and ALL shows then sitting in
 * blackout shape yielded zero dates — so keying solely on review dates silenced
 * the alarm corpus-wide, including Matilda (Theatre Row), genuinely open since
 * 2026-08-06 with two discovered URLs and nothing collected.
 *
 * (1) also covers the nastiest shape: when a real review set is wrongly flagged
 * wrongProduction/wrongShow, the flags both CAUSE the blackout and erase the
 * dated evidence, so review data can never license the alarm. The show record
 * is the only witness left.
 *
 * @param {object} show
 * @param {string[]} openedDates dates from datesFromDiscoveredReviews
 * @param {string} today YYYY-MM-DD
 * @returns {boolean}
 */
function hasOpened(show, openedDates, today) {
  if (show.status === 'open' && show.openingDate && show.openingDate <= today) return true;
  // A future or garbage date must not license the alarm — the sibling signal
  // openSignalFromDiscovery applies the same isDateReached guard.
  return (openedDates || []).some(d => d <= today);
}

/**
 * Assess one show's review files.
 *
 * @param {{id: string, title?: string, status?: string}} show
 * @param {Array<{file: string, review: object}>} files
 * @param {{nowMs: number, maxAgeHours?: number}} opts
 * @returns {{showId: string, title: string, status: string, stranded: Array, usable: number, discovered: number, totalBlackout: boolean}|null}
 *          null when the show is not live (out of scope).
 */
function assessShow(show, files, { nowMs, maxAgeHours = DEFAULT_MAX_AGE_HOURS } = {}) {
  if (!show || !LIVE_STATUSES.has(show.status)) return null;

  const stranded = [];
  let usable = 0;
  let discovered = 0;
  // Evidence the show's press night has actually happened: at least one clean
  // discovered review carrying a real date on/after previews began.
  //
  // Skipped entirely without previewsStartDate — datesFromDiscoveredReviews
  // only filters out prior-production dates when it has that boundary, so
  // without it a 2003 revival's review would read as this run's press night.
  // openSignalFromDiscovery refuses to guess in the same situation; the
  // show-record branch of hasOpened() still covers these shows.
  const openedDates = show.previewsStartDate
    ? datesFromDiscoveredReviews((files || []).map(f => f.review), show)
    : [];
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const siblings = new Map((files || []).map(f => [f.file, f.review]));

  for (const { file, review } of files || []) {
    if (review && review.url && !isOtherProductionEvidence(show, review)) discovered++;
    if (review && (review.fullText || '').length > 200) usable++;
    if (!isNeverAttempted(review)) continue;
    if (hasTerminalVerdict(review, siblings)) continue;
    const ageHours = strandAgeHours(review, nowMs);
    // An undatable strand still counts — a missing timestamp must not buy a
    // file an exemption, which is the same "null field silences the check"
    // bug this whole module exists to close.
    if (ageHours === null || ageHours >= maxAgeHours) {
      stranded.push({ file, url: review.url, outlet: review.outlet || null, ageHours });
    }
  }

  return {
    showId: show.id,
    title: show.title || show.id,
    status: show.status,
    stranded,
    usable,
    discovered,
    // The catastrophic shape: a live show the site shows no critics for at all,
    // while we hold its review URLs on disk. Threshold 2, not 3 — an
    // Off-Broadway show can have its whole press slate be two outlets, and a
    // blackout is a blackout at that size too.
    //
    // hasOpened() is load-bearing in BOTH directions, and the two failure modes
    // pull against each other:
    //   - Without it this fires on every show still in previews, which always
    //     has zero usable reviews. Abigail's Party tripped exactly that on
    //     2026-08-13 (previews 08-12, press night 08-19, six dead links to
    //     earlier revivals of the Mike Leigh play).
    //   - Keying it on review dates ALONE silences the alarm corpus-wide,
    //     because almost no uncollected file carries a parseable date. That
    //     over-correction shipped briefly the same day and hid a real blackout.
    // A monitor that cries wolf on unopened shows gets ignored; a monitor that
    // never fires is worse. Both are the failure that produced this incident.
    totalBlackout: usable === 0 && discovered >= 2 && hasOpened(show, openedDates, today),
  };
}

/** Hours a never-fetched stub may age before the any-status check flags it (BRO-6123). */
const AGED_STUB_MAX_AGE_HOURS = 48;

/**
 * Status-independent twin of the strand check: never-fetched files with a URL
 * that have waited at least `maxAgeHours`, for ANY show (closed ones included).
 *
 * assessShow only looks at open/previews shows, so 176 theatre.reviews stubs on
 * closed 2024-2026 West End shows sat unfetched through two collector runs with
 * nothing flagging them (BRO-6123). A file with no firstSeenAt counts as aged,
 * same rule as strands. Files with a terminal verdict or a duplicateOf pointer
 * are excluded exactly as in assessShow.
 *
 * @param {Array<{file: string, review: object}>} files one show's review files
 * @param {{nowMs: number, maxAgeHours?: number}} opts
 * @returns {Array<{file: string, url: string, outlet: string|null, ageHours: number|null}>}
 */
function findAgedStubs(files, { nowMs, maxAgeHours = AGED_STUB_MAX_AGE_HOURS } = {}) {
  const siblings = new Map((files || []).map(f => [f.file, f.review]));
  const out = [];
  for (const { file, review } of files || []) {
    if (!isNeverAttempted(review)) continue;
    if (Array.isArray(review.fetchAttempts) && review.fetchAttempts.length > 0) continue;
    if (hasTerminalVerdict(review, siblings)) continue;
    const ageHours = strandAgeHours(review, nowMs);
    if (ageHours === null || ageHours >= maxAgeHours) {
      out.push({ file, url: review.url, outlet: review.outlet || null, ageHours });
    }
  }
  return out;
}

/**
 * Open `uncollected-blackout:<id>` ledger keys whose show is no longer in the
 * current blackout set. Nothing else ever resolves these (BRO-5077: 14 sat
 * open forever, so every card's "condition absent" acceptance check could
 * never pass even after the data was fixed).
 *
 * @param {Object<string, {status?: string}>} conditions ledger.conditions
 * @param {Iterable<string>} blackoutShowIds current blackouts
 * @returns {string[]} conditionKeys to resolve
 */
function staleBlackoutKeys(conditions, blackoutShowIds) {
  const live = new Set(blackoutShowIds || []);
  const prefix = 'uncollected-blackout:';
  return Object.keys(conditions || {}).filter(k =>
    k.startsWith(prefix) && conditions[k] && conditions[k].status === 'open' && !live.has(k.slice(prefix.length)));
}

module.exports = {
  findAgedStubs,
  AGED_STUB_MAX_AGE_HOURS,
  staleBlackoutKeys,
  LIVE_STATUSES,
  DEFAULT_MAX_AGE_HOURS,
  isNeverAttempted,
  hasTerminalVerdict,
  isOtherProductionEvidence,
  strandAgeHours,
  assessShow,
};
