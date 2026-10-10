'use strict';

/**
 * Pure decision functions for data/commercial-research-queue.json writers.
 * Extracted from the three inline `node -e` heredocs in
 * update-show-status.yml ("Queue new Broadway shows", "Queue pre-opening
 * shows", "Queue closing TBD shows") per the test-extraction pattern —
 * untestable-in-YAML logic gets a CLI wrapper (scripts/queue-commercial-
 * research.js) + colocated-tested lib (this file), mirroring
 * scripts/lib/ob-closing-detector.js.
 *
 * Category-race fix (2026-07-19, plan-review finding): isCommercialScope()
 * intentionally defaults an unset `category` to Broadway — correct for
 * long-standing shows, wrong for a show discovered earlier in the SAME
 * workflow run before classification has set its category. The three
 * filters below differ in whether that race applies:
 *   - filterNewBroadwayShows: EVERY input slug is, by construction, newly
 *     discovered this same run (its only caller passes
 *     steps.discover.outputs.new_slugs) — always requires category ===
 *     'broadway' explicitly, never falls back to isCommercialScope().
 *   - filterPreOpeningShows / filterClosingTbdShows: scan the FULL
 *     shows.json for date-based triggers (opening tomorrow / closed in the
 *     last week) — these shows have existed long enough for classification
 *     to have already run in a prior workflow execution, so the same-run
 *     race does not apply and isCommercialScope()'s normal default is
 *     correct and intentional here (do not tighten these two).
 */

const { isCommercialScope } = require('./commercial-scope');
const { getSeasonForDate } = require('./broadway-seasons');

/**
 * Filter newly-discovered slugs down to ones confirmed Broadway. Every slug
 * passed in is assumed to be from this run's discovery step — see the
 * module doc comment for why this uses a stricter check than
 * isCommercialScope() alone.
 * @param {string[]} slugs
 * @param {object[]} shows — shows.json's shows array
 * @returns {string[]}
 */
function filterNewBroadwayShows(slugs, shows) {
  // Two separate maps, checked slug-first (ship-check finding, 2026-07-19):
  // a single map keyed by both slug AND id lets one show's id silently
  // overwrite another show's slug entry if the two strings ever collide —
  // whichever show iterates last would win. Deterministic slug-priority
  // matches resolveScopeShow()'s convention (commercial-scope.js).
  const bySlug = new Map();
  const byId = new Map();
  for (const s of shows) {
    if (s.slug) bySlug.set(s.slug, s);
    if (s.id) byId.set(s.id, s);
  }
  const out = [];
  for (const slug of slugs) {
    const show = bySlug.get(slug) || byId.get(slug);
    // Intentionally NOT isBroadwayCategory(): see the module doc comment above
    // (category-race fix) — this filter must never fall back to isCommercialScope()'s
    // permissive null-category default.
    if (!show || show.category !== 'broadway') continue;
    // Queue the show's SLUG even when the caller passed its id: deep-research
    // keys pending entries and commercial.json writes by the queued string
    // (BRO-4623).
    const key = show.slug || slug;
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

/**
 * Broadway shows opening on `tomorrowStr` (UTC, YYYY-MM-DD) that don't
 * already have a non-TBD commercial designation.
 * @param {object[]} shows
 * @param {{shows?: Record<string, {designation?: string}>}} commercial
 * @param {string} tomorrowStr
 * @returns {string[]}
 */
function filterPreOpeningShows(shows, commercial, tomorrowStr) {
  const commShows = (commercial && commercial.shows) || {};
  return shows
    .filter((s) => {
      if (!s || !s.openingDate) return false;
      if (s.openingDate !== tomorrowStr) return false;
      if (!isCommercialScope(s)) return false;
      // Check both keys (ship-check finding, 2026-07-19): commercial.json
      // entries aren't guaranteed to be keyed the same way s.slug || s.id
      // resolves — a show covered under the OTHER key form was silently
      // treated as uncovered and requeued.
      const entry = commShows[s.slug] || commShows[s.id];
      if (entry && entry.designation && entry.designation !== 'TBD') return false;
      return true;
    })
    .map((s) => s.slug || s.id);
}

/**
 * Broadway shows that closed within the last week and are still TBD or
 * uncovered in commercial.json.
 * @param {object[]} shows
 * @param {{shows?: Record<string, {designation?: string}>}} commercial
 * @param {string} weekAgoStr
 * @param {string} todayStr
 * @returns {string[]}
 */
function filterClosingTbdShows(shows, commercial, weekAgoStr, todayStr) {
  const commShows = (commercial && commercial.shows) || {};
  return shows
    .filter((s) => {
      if (!s || s.status !== 'closed') return false;
      if (!isCommercialScope(s)) return false;
      if (!s.closingDate || s.closingDate < weekAgoStr || s.closingDate > todayStr) return false;
      const entry = commShows[s.slug] || commShows[s.id];
      if (!entry) return true;
      if (entry.designation === 'TBD') return true;
      return false;
    })
    .map((s) => s.slug || s.id);
}

/**
 * Add slugs to a queue object in place-safe fashion (returns a new object),
 * deduping shows[] and tagging triggers[slug] = trigger for each.
 * @param {{shows?: string[], triggers?: Record<string,string>, updatedAt?: string}} queue
 * @param {string[]} slugs
 * @param {string} trigger
 */
function addToQueue(queue, slugs, trigger) {
  const next = {
    shows: [...new Set([...(queue.shows || []), ...slugs])],
    triggers: { ...(queue.triggers || {}) },
    updatedAt: new Date().toISOString(),
  };
  for (const slug of slugs) {
    next.triggers[slug] = trigger;
  }
  return next;
}

/**
 * Owner-approved floor for commercial research (BRO-4990, 2026-10-10:
 * "Research older shows: only back to 2020 for now"). Nothing that opened
 * before this date is selected by the automatic sweeps below.
 */
const COMMERCIAL_RESEARCH_FLOOR = '2020-01-01';
const DEFAULT_MIN_WEEKS = 8;

function commercialEntryFor(commShows, s) {
  return commShows[s.slug] || commShows[s.id] || null;
}

/**
 * Weeks a show played: opening to closing, or to today while running.
 * null when it has not opened (no openingDate, or opening after today).
 * @param {object} s
 * @param {string} todayStr YYYY-MM-DD
 */
function weeksRun(s, todayStr) {
  if (!s || !s.openingDate || s.openingDate > todayStr) return null;
  const end = s.closingDate && s.closingDate <= todayStr ? s.closingDate : todayStr;
  const ms = new Date(end + 'T00:00:00Z') - new Date(s.openingDate + 'T00:00:00Z');
  return Number.isFinite(ms) ? Math.max(0, ms / (7 * 86_400_000)) : null;
}

/**
 * Self-healing sweep (BRO-4990): CLOSED Broadway shows that opened on/after
 * the floor, ran at least minWeeks, and have no commercial.json record at
 * all. The event triggers (new-show, pre-opening, closing) miss any show
 * whose window passed while a workflow was down or before the trigger
 * existed: 24 shows from 2021-2023 sat uncovered that way. Open/previews
 * shows are already swept by deep-research's --all-tbd "uncovered" tier.
 * @param {object[]} shows
 * @param {{shows?: Record<string, object>}} commercial
 * @param {string} todayStr
 * @param {{since?: string, minWeeks?: number}} [opts]
 * @returns {string[]}
 */
function filterUncoveredClosedShows(shows, commercial, todayStr, opts = {}) {
  const since = opts.since || COMMERCIAL_RESEARCH_FLOOR;
  const minWeeks = opts.minWeeks == null ? DEFAULT_MIN_WEEKS : opts.minWeeks;
  const commShows = (commercial && commercial.shows) || {};
  return shows
    .filter((s) => {
      if (!s || s.status !== 'closed') return false;
      if (!isCommercialScope(s)) return false;
      if (!s.openingDate || s.openingDate < since) return false;
      const wk = weeksRun(s, todayStr);
      if (wk == null || wk < minWeeks) return false;
      return !commercialEntryFor(commShows, s);
    })
    .map((s) => s.slug || s.id);
}

/**
 * Coverage by season for the weekly health output (BRO-4990). Counts
 * Broadway shows that opened on/after `since`. "eligible" = ran (or has been
 * running) at least minWeeks; "covered" = has a commercial.json record;
 * "resolved" = that record's designation is not TBD.
 * @returns {{season:string, inScope:number, eligible:number, covered:number, resolved:number, uncovered:string[]}[]}
 */
function computeCoverageBySeason(shows, commercial, todayStr, opts = {}) {
  const since = opts.since || COMMERCIAL_RESEARCH_FLOOR;
  const minWeeks = opts.minWeeks == null ? DEFAULT_MIN_WEEKS : opts.minWeeks;
  const commShows = (commercial && commercial.shows) || {};
  // Pending-review keys: researched, waiting on a human (BRO-4990 backfill).
  const pendingShows = opts.pendingShows || {};
  const bySeason = new Map();
  for (const s of shows) {
    if (!s || !isCommercialScope(s)) continue;
    if (!s.openingDate || s.openingDate < since) continue;
    // Season from the opening date (one Jul-Jun rule for every show): the
    // stored `season` field is missing on ~70 2020+ Broadway rows.
    let season;
    try { season = getSeasonForDate(s.openingDate); } catch { season = s.season || 'unknown'; }
    if (!bySeason.has(season)) bySeason.set(season, { season, inScope: 0, eligible: 0, covered: 0, resolved: 0, pendingReview: [], uncovered: [] });
    const row = bySeason.get(season);
    row.inScope++;
    const wk = weeksRun(s, todayStr);
    if (wk == null || wk < minWeeks) continue;
    row.eligible++;
    const entry = commercialEntryFor(commShows, s);
    if (!entry) {
      const inPending = (s.slug && pendingShows[s.slug]) || (s.id && pendingShows[s.id]);
      // A noData row records a pass that found nothing: still uncovered.
      (inPending && !inPending.noData ? row.pendingReview : row.uncovered).push(s.slug || s.id);
      continue;
    }
    row.covered++;
    if (entry.designation && entry.designation !== 'TBD') row.resolved++;
  }
  return [...bySeason.values()].sort((a, b) => a.season.localeCompare(b.season));
}

module.exports = {
  COMMERCIAL_RESEARCH_FLOOR,
  weeksRun,
  filterUncoveredClosedShows,
  computeCoverageBySeason,
  filterNewBroadwayShows,
  filterPreOpeningShows,
  filterClosingTbdShows,
  addToQueue,
};
