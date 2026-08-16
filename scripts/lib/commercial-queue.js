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
  return slugs.filter((slug) => {
    const show = bySlug.get(slug) || byId.get(slug);
    // Intentionally NOT isBroadwayCategory(): see the module doc comment above
    // (category-race fix) — this filter must never fall back to isCommercialScope()'s
    // permissive null-category default.
    return !!show && show.category === 'broadway';
  });
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

module.exports = {
  filterNewBroadwayShows,
  filterPreOpeningShows,
  filterClosingTbdShows,
  addToQueue,
};
