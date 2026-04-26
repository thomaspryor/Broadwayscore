'use strict';

/**
 * Tonight #7 (Joe Turner postmortem) — pure helpers for the watcher's
 * "is a poller already in-flight for this show?" idempotency check.
 *
 * The thin gh-CLI wrapper lives in scripts/watch-aggregator-urls.js;
 * the parsing + matching logic is here so it can be unit-tested.
 *
 * Detection contract: opening-night-poller.yml sets
 *   run-name: Opening Night Poller — ${{ inputs.show_id || 'auto' }}
 * which surfaces as `displayTitle` on the gh run list JSON. We match by
 * suffix to avoid false positives on sibling show IDs (a show id of
 * "the-bear-2025" must not match an in-flight run for
 * "the-bear-bites-back-2025").
 */

const RUN_NAME_SEPARATOR = '— ';

function buildTitleSuffix(showId) {
  return `${RUN_NAME_SEPARATOR}${showId}`;
}

function isActiveStatus(status) {
  return status === 'in_progress' || status === 'queued';
}

/**
 * @param {Array<{databaseId:number,displayTitle:string,status:string,createdAt:string}>} runs
 *   gh run list --json output (or equivalent fixture).
 * @param {string} showId  show slug from data/shows.json (e.g. "joe-turners-come-and-gone-2026").
 * @returns {object|null}  the first matching run, or null.
 */
function findInFlightPollerForShow(runs, showId) {
  if (!Array.isArray(runs) || !showId) return null;
  const suffix = buildTitleSuffix(showId);
  return (
    runs.find(
      r =>
        r &&
        isActiveStatus(r.status) &&
        typeof r.displayTitle === 'string' &&
        r.displayTitle.endsWith(suffix),
    ) || null
  );
}

module.exports = {
  buildTitleSuffix,
  isActiveStatus,
  findInFlightPollerForShow,
  RUN_NAME_SEPARATOR,
};
