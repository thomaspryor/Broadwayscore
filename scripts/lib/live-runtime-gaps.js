'use strict';
/**
 * live-runtime-gaps.js (BRO-7917): which live shows have no usable runtime.
 *
 * The iOS calendar reminder and Stats read each show's `runtime`; a live show
 * without one falls back to a default length, so the reminder end time and the
 * "hours watched" stat are wrong for it. validate-data.js reports the count as a
 * warning (advisory, CLAUDE.md rule 19) so the gap stays visible.
 *
 * "Live" = the effective status the site and app feed show (effective-status.js:
 * an expired "open" row counts as closed, a preview not yet started as upcoming)
 * is open or previews. "Usable" = parseRuntimeMinutes accepts it, the same parser
 * the calendar uses, so "varies" or "0h" still counts as missing. Regional rows
 * (category or market "regional") are reported separately: the app seed the card
 * measured was NYC and London.
 */

const { parseRuntimeMinutes } = require('./parse-runtime');
const { effectiveShowStatus } = require('./effective-status');

const LIVE_STATUSES = new Set(['open', 'previews']);

const isRegional = (show) => show.category === 'regional' || show.market === 'regional';

/**
 * @param {object[]} shows shows.json rows
 * @param {{ today?: string }} [opts] YYYY-MM-DD override (tests); default is each show's market date
 * @returns {{ core: object[], regional: object[] }} live rows without a usable runtime
 */
function liveShowsMissingRuntime(shows, opts = {}) {
  const core = [];
  const regional = [];
  for (const show of shows || []) {
    if (!show || !show.status) continue;
    const status = opts.today ? effectiveShowStatus(show, opts.today) : effectiveShowStatus(show);
    if (!LIVE_STATUSES.has(status)) continue;
    if (parseRuntimeMinutes(show.runtime) != null) continue;
    (isRegional(show) ? regional : core).push(show);
  }
  return { core, regional };
}

module.exports = { liveShowsMissingRuntime, LIVE_STATUSES };
