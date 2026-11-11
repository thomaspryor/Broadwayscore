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
 * NOTE: since BRO-4209 an auto run only counts as coverage for dispatches
 * WITHOUT an override URL; see findInFlightCoverage below.
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

/**
 * Coverage check used by the watcher before dispatching. An auto poller only
 * covers a show when the watcher has nothing new to hand over. A dispatch that
 * carries a discovered aggregator URL override (bww_roundup_url) is NOT covered
 * by an auto run: the auto run polls on its own schedule and never sees the
 * override, and on multi-show nights an auto poller is active for the whole
 * orchestrator loop (BRO-4209). Targeted runs use a per-show concurrency group,
 * so they cannot race the auto group; a same-show targeted run still skips
 * (the Joe Turner push-storm guard). A targeted run does run in parallel with
 * an auto run (different concurrency groups); that overlap is accepted per
 * BRO-4273 and relies on push-with-retry.sh for concurrent writes.
 *
 * @param {Array} runs
 * @param {string} showId
 * @param {{hasOverrideUrl?: boolean}} [opts]
 * @returns {object|null}
 */
function findInFlightCoverage(runs, showId, opts = {}) {
  if (opts.hasOverrideUrl) return findInFlightTargetedPollerForShow(runs, showId);
  return findInFlightPollerForShow(runs, showId);
}

/**
 * BRO-7117: the show id a poller run is targeting, read from its run-name
 * (`Opening Night Poller — <show_id>`). Auto runs (`— auto`) and titles
 * without the separator return null.
 *
 * @param {string} title
 * @returns {string|null}
 */
function targetedShowIdFromTitle(title) {
  if (typeof title !== 'string') return null;
  const at = title.lastIndexOf(RUN_NAME_SEPARATOR);
  if (at < 0) return null;
  const id = title.slice(at + RUN_NAME_SEPARATOR.length).trim();
  if (!id || id === 'auto') return null;
  return id;
}

/**
 * BRO-7117: show ids that an ACTIVE targeted poller run owns right now,
 * mapped to that run's id (databaseId) for logging.
 *
 * Why: an auto/market poller and a targeted per-show poller sit in different
 * concurrency groups, so on a press night (orchestrator BRO-7198 parallel
 * dispatch, update-show-status, the watcher, post-lane sweeps) both used to
 * gather, collect and score the SAME show at the same time. Half the
 * "Opening Night Poller Failed" cards in Oct-Nov 2026 were that overlap
 * (BRO-5716, BRO-6594 _pending rename races; BRO-7338 both runs crashed in
 * collect). The auto run now leaves those shows to the targeted run.
 *
 * @param {Array} runs  gh run list --json databaseId,status,displayTitle output.
 * @returns {Map<string, (number|string|null)>}
 */
function activeTargetedPollerShows(runs) {
  const owned = new Map();
  if (!Array.isArray(runs)) return owned;
  for (const r of runs) {
    if (!isActiveRun(r)) continue;
    const id = targetedShowIdFromTitle(r.displayTitle);
    if (id && !owned.has(id)) owned.set(id, r.databaseId ?? null);
  }
  return owned;
}

/**
 * BRO-7117: split an auto run's show list into the shows it should still
 * work on and the shows an active targeted run already owns.
 *
 * @param {Array} runs
 * @param {string[]} showIds
 * @returns {{keep: string[], owned: Array<{showId: string, runId: (number|string|null)}>}}
 */
function partitionByActiveTargetedPoller(runs, showIds) {
  const active = activeTargetedPollerShows(runs);
  const keep = [];
  const owned = [];
  for (const id of showIds || []) {
    if (!id) continue;
    if (active.has(id)) owned.push({ showId: id, runId: active.get(id) });
    else keep.push(id);
  }
  return { keep, owned };
}

module.exports = {
  targetedShowIdFromTitle,
  activeTargetedPollerShows,
  partitionByActiveTargetedPoller,
  findInFlightCoverage,
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
