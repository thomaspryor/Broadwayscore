'use strict';
/**
 * live-runtime-gaps.js (BRO-7917): which live shows have no runtime.
 *
 * The iOS calendar reminder and Stats read each show's `runtime`; a live show
 * without one falls back to a default length, so the reminder end time and the
 * "hours watched" stat are wrong for it. validate-data.js reports the count as a
 * warning (advisory, CLAUDE.md rule 19) so the gap stays visible.
 *
 * "Live" = status open or previews. Regional rows are counted separately: the
 * app seed the card measured carries NYC and London only.
 */

const LIVE_STATUSES = new Set(['open', 'previews']);

function hasRuntime(show) {
  return typeof show.runtime === 'string' ? show.runtime.trim() !== '' : show.runtime != null && show.runtime !== '';
}

/**
 * @param {object[]} shows shows.json rows
 * @returns {{ core: object[], regional: object[] }} live rows lacking a runtime,
 *   split into NYC/London (`core`) and `regional`
 */
function liveShowsMissingRuntime(shows) {
  const core = [];
  const regional = [];
  for (const show of shows || []) {
    if (!show || !LIVE_STATUSES.has(show.status) || hasRuntime(show)) continue;
    (show.market === 'regional' ? regional : core).push(show);
  }
  return { core, regional };
}

module.exports = { liveShowsMissingRuntime, LIVE_STATUSES };
