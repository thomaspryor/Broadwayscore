'use strict';

/**
 * Tonight #7 (Joe Turner postmortem) — pure helpers for the watcher's
 * "is a poller already in-flight that covers this show?" idempotency check.
 *
 * The thin gh-CLI wrapper lives in scripts/watch-aggregator-urls.js;
 * the parsing + matching logic is here so it can be unit-tested.
 *
 * Detection contract: opening-night-poller.yml sets
 *   run-name: Opening Night Poller — ${{ inputs.show_id || 'auto' }}
 * which surfaces as `displayTitle` on the gh run list JSON.
 *
 * A targeted poller (`— ${showId}`) covers exactly that show.
 * An "auto" poller (`— auto`) iterates ALL of today's openings — so it
 * covers any show the watcher might dispatch for. Both are treated as
 * "in-flight coverage" by findInFlightPollerForShow, because both will
 * write to data/review-texts for the same opening, and the Joe Turner
 * 2026-04-25 push storm involved exactly this auto+targeted overlap
 * (update-show-status.yml dispatches with no show_id; orchestrator's
 * multi-show branch also dispatches without show_id).
 *
 * The suffix match is anchored to em-dash + space + slug to avoid prefix
 * collisions ("the-bear-2025" must not match "the-bear-bites-back-2025").
 */

const RUN_NAME_SEPARATOR = '— ';
const AUTO_RUN_SUFFIX = `${RUN_NAME_SEPARATOR}auto`;

// GitHub Actions run states that mean "active" — i.e. will write to data/
// before completing. Includes the lifecycle states the API can transition
// through before in_progress (waiting/pending/requested), per
// https://docs.github.com/en/rest/actions/workflow-runs and consistent
// with .github/workflows/deploy-on-data-change.yml's own active-run check
// (which already treats `waiting` as active). Codex review 2026-04-26
// flagged the prior in_progress|queued-only check as too narrow.
const ACTIVE_STATUSES = new Set([
  'in_progress',
  'queued',
  'waiting',
  'pending',
  'requested',
]);

function buildTitleSuffix(showId) {
  return `${RUN_NAME_SEPARATOR}${showId}`;
}

function isActiveStatus(status) {
  return ACTIVE_STATUSES.has(status);
}

function isActiveRun(run) {
  // Coerce to Boolean — assert.equal(..., false) rejects null/undefined.
  return Boolean(
    run &&
    isActiveStatus(run.status) &&
    typeof run.displayTitle === 'string',
  );
}

/**
 * Find an in-flight auto-discovery poller, if any. An auto run iterates
 * ALL of today's openings, so it covers any show the watcher targets.
 *
 * @param {Array} runs  gh run list --json output.
 * @returns {object|null}
 */
function findInFlightAutoPoller(runs) {
  if (!Array.isArray(runs)) return null;
  return runs.find(r => isActiveRun(r) && r.displayTitle.endsWith(AUTO_RUN_SUFFIX)) || null;
}

/**
 * Find an in-flight targeted poller for the given show, if any. Strict
 * same-show suffix match — does NOT consider auto runs.
 *
 * @param {Array} runs
 * @param {string} showId
 * @returns {object|null}
 */
function findInFlightTargetedPollerForShow(runs, showId) {
  if (!Array.isArray(runs) || !showId) return null;
  const suffix = buildTitleSuffix(showId);
  return runs.find(r => isActiveRun(r) && r.displayTitle.endsWith(suffix)) || null;
}

/**
 * Find any in-flight poller that covers the given show — either a targeted
 * run for the same show, or an auto run (which covers all today's openings).
 * Targeted match takes priority for log clarity.
 *
 * @param {Array} runs
 * @param {string} showId
 * @returns {object|null}
 */
function findInFlightPollerForShow(runs, showId) {
  // Defensive: with no showId we have nothing to skip dispatch for, so
  // don't fall through to auto-coverage. Caller is expected to pass a
  // real slug from data/shows.json.
  if (!Array.isArray(runs) || !showId) return null;
  const targeted = findInFlightTargetedPollerForShow(runs, showId);
  if (targeted) return targeted;
  return findInFlightAutoPoller(runs);
}

module.exports = {
  buildTitleSuffix,
  isActiveStatus,
  isActiveRun,
  findInFlightPollerForShow,
  findInFlightTargetedPollerForShow,
  findInFlightAutoPoller,
  RUN_NAME_SEPARATOR,
  AUTO_RUN_SUFFIX,
  ACTIVE_STATUSES,
};
