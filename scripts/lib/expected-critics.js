'use strict';

/**
 * expected-critics.js (BRO-7166): the search-free completeness check.
 *
 * For each market, history says which outlets review nearly every opening
 * (outlet-registry.json standingCoverage + standingMarkets, earned and
 * re-measured by scripts/audit-standing-coverage.js). When one of them has no
 * review of an opening 72h after it opened, that is a question with three
 * answers: the review is live now ('live'), the outlet checked and did not
 * review it ('not-reviewed', recorded as an ack in data/audit/t1-coverage-ack.json,
 * the same store the T1 scoreboard reads), or nobody knows yet ('missing').
 *
 * Why this exists: the Broadway ledger already marked School Girls / NY Post
 * as a GAP on 2026-09-28, but its one email per cell went out once and then
 * nothing for six weeks, and the West End had no expected set at all.
 * Surfaces: health-check.js "Quality: expected critics missing" (daily digest,
 * advisory) and the opening grade line (scripts/lib/opening-grade.js).
 *
 * Pure: every input is passed in.
 */

const { STANDING_MARKETS, marketFold, MIN_PRESS_OUTLETS } = require('../audit-standing-coverage');
const { standingOutletIds } = require('./standing-outlets');
const { isNoReviewExpectedActive } = require('./coverage-expectation');

const DAY_MS = 86400000;
const FROM_HOURS = 72; // reviews land within a day or two of press night
const TO_DAYS = 42; // long enough that a six-week-old gap (School Girls) still shows
// Same floor the standing sets are measured on (audit-standing-coverage.js): below it a show
// drew little press, and the standing outlets' hit rate there is ~27-47%, not ~87%.
const MIN_LIVE_OUTLETS = MIN_PRESS_OUTLETS;

const cellKey = (showId, outletId) => `${showId}::${outletId}`;

/** End of opening day (UTC). Date-only openings read as "that evening". */
function openedAtMs(show) {
  const ms = show && show.openingDate ? Date.parse(String(show.openingDate).slice(0, 10)) : NaN;
  return Number.isFinite(ms) ? ms + DAY_MS : null;
}

/** id -> registry key, via the registry's `aliases` (lower-cased). Registry keys map to themselves. */
function aliasCanon(outlets) {
  const map = new Map();
  for (const [key, o] of Object.entries(outlets || {})) {
    for (const a of (o && Array.isArray(o.aliases) ? o.aliases : [])) {
      const k = String(a).toLowerCase();
      if (!map.has(k)) map.set(k, key);
    }
  }
  const has = (id) => Object.prototype.hasOwnProperty.call(outlets || {}, id);
  return (id) => (has(id) ? id : map.get(String(id).toLowerCase()) || id);
}

/** Map showId -> Set(outletIds with a review in reviews.json), alias-resolved and folded per the show's market. */
function liveOutletsByShow(shows, reviews, outlets) {
  const canon = aliasCanon(outlets);
  const catById = new Map((shows || []).map((s) => [s.id, s.category]));
  const folds = new Map();
  const out = new Map();
  for (const r of reviews || []) {
    if (!r || !r.showId || !r.outletId || !catById.has(r.showId)) continue;
    const cat = catById.get(r.showId);
    if (!folds.has(cat)) folds.set(cat, marketFold(outlets, cat));
    const fold = folds.get(cat);
    if (!out.has(r.showId)) out.set(r.showId, new Set());
    const id = canon(r.outletId);
    out.get(r.showId).add(fold ? fold(id) : id);
  }
  return out;
}

/**
 * Status of one (show, outlet) cell.
 * @returns {'live'|'not-reviewed'|'not-expected'|'missing'}
 */
function cellStatus({ showId, outletId, live, acks, outlets, nowMs }) {
  if (live && live.has(outletId)) return 'live';
  const key = cellKey(showId, outletId);
  if ((acks || []).some((a) => a && a.key === key)) return 'not-reviewed';
  if (isNoReviewExpectedActive(outlets, outletId, nowMs)) return 'not-expected';
  return 'missing';
}

/**
 * Every expected cell for openings in the window, with its status.
 * @param {{shows: object[], reviews: object[], outlets: object, acks?: object[], nowMs: number,
 *          fromHours?: number, toDays?: number, since?: string, until?: string, market?: string}} p
 *   since/until (YYYY-MM-DD) replace the age window with an opening-date range (the audit CLI).
 * @returns {Array<{showId, title, category, openingDate, ageDays, outletId, outletName, status, ackNote}>}
 */
function findExpectedCriticGaps({ shows, reviews, outlets, acks = [], nowMs, fromHours = FROM_HOURS, toDays = TO_DAYS, since, until, market }) {
  const live = liveOutletsByShow(shows, reviews, outlets);
  const rows = [];
  for (const show of shows || []) {
    if (!show || !STANDING_MARKETS.includes(show.category)) continue;
    if (market && show.category !== market) continue;
    const opened = openedAtMs(show);
    if (opened == null) continue;
    const ageHours = (nowMs - opened) / 3600000;
    if (ageHours < fromHours) continue; // too early to call anything missing, any mode
    const date = String(show.openingDate).slice(0, 10);
    if (since || until) {
      if (since && date < since) continue;
      if (until && date > until) continue;
    } else if (ageHours > toDays * 24) continue;
    const showLive = live.get(show.id) || new Set();
    if (showLive.size < MIN_LIVE_OUTLETS) continue; // no press night (yet): a show-level fact
    for (const outletId of standingOutletIds(outlets, show.category)) {
      const status = cellStatus({ showId: show.id, outletId, live: showLive, acks, outlets, nowMs });
      const ack = status === 'not-reviewed' ? acks.find((a) => a && a.key === cellKey(show.id, outletId)) : null;
      rows.push({
        showId: show.id,
        title: show.title,
        category: show.category,
        openingDate: date,
        ageDays: Math.floor((nowMs - Date.parse(date)) / DAY_MS), // calendar days since opening
        outletId,
        outletName: (outlets[outletId] && outlets[outletId].displayName) || outletId,
        status,
        ackNote: ack ? ack.note || '' : undefined,
      });
    }
  }
  rows.sort((a, b) => b.ageDays - a.ageDays || a.showId.localeCompare(b.showId) || a.outletId.localeCompare(b.outletId));
  return rows;
}

/**
 * Explicit status for named cells (the card's list), expected set or not.
 * @param {string[]} keys  'showId::outletId'
 */
function statusForCells({ keys, shows, reviews, outlets, acks = [], nowMs }) {
  const byId = new Map((shows || []).map((s) => [s.id, s]));
  const live = liveOutletsByShow(shows, reviews, outlets);
  return keys.map((key) => {
    const [showId, outletId] = String(key).split('::');
    const show = byId.get(showId);
    if (!show || !outletId) return { key, showId, outletId, status: 'unknown-show' };
    const status = cellStatus({ showId, outletId, live: live.get(showId), acks, outlets, nowMs });
    const ack = acks.find((a) => a && a.key === cellKey(showId, outletId));
    return {
      key, showId, outletId, title: show.title, category: show.category,
      openingDate: show.openingDate ? String(show.openingDate).slice(0, 10) : null,
      expected: standingOutletIds(outlets, show.category).includes(outletId),
      status, ackNote: ack ? ack.note || '' : undefined,
    };
  });
}

/** Missing cells for one show, as [{outletId, name}] for the opening grade. */
function expectedMissingForShow(showId, gaps) {
  return (gaps || [])
    .filter((g) => g.showId === showId && g.status === 'missing')
    .map((g) => ({ outletId: g.outletId, name: g.outletName }));
}

module.exports = {
  findExpectedCriticGaps,
  statusForCells,
  expectedMissingForShow,
  liveOutletsByShow,
  aliasCanon,
  cellKey,
  FROM_HOURS,
  TO_DAYS,
  MIN_LIVE_OUTLETS,
};
