'use strict';

/**
 * backlog-inflow-ratio.js — how fast the Linear backlog is filling versus
 * draining, as a number the owner sees every morning (BRO-3017).
 *
 * WHY THIS EXISTS. On 2026-09-07 a paginated count found 1,072 open BRO
 * issues, 264 filed and 59 closed since 2026-09-01 — 4.5 filed per 1 closed.
 * Nothing in the fleet reported that ratio, which is the whole reason it
 * reached 4.5 unnoticed: every existing signal counts a THING (stuck items,
 * unmerged PRs, dead relays), and none counts the RATE. The owner's decision
 * (2026-09-08, "B then A") was to make the inflow visible before draining
 * anything, because a drain that runs against a 4.5:1 inflow just refills.
 *
 * PAGINATION IS THE POINT, NOT AN IMPLEMENTATION DETAIL. Linear's `issues`
 * connection silently caps at 250 nodes per page. The first read of this
 * backlog came back as exactly "250 open" and looked like a small, healthy
 * board. Every count here walks `pageInfo.hasNextPage` and, if it ever hits
 * MAX_PAGES, reports `truncated: true` — which assessInflowRatio turns into a
 * loud "this number is a floor" rather than a quietly wrong ratio. A metric
 * whose failure mode is "looks better than reality" is worse than no metric.
 *
 * TERMINAL STATES. Closure is counted from `completedAt`, not from a
 * hand-rolled state-name list — see linear-state-types.js for the BRO team's
 * three terminal types and the 19-issue miscount that taught us that. Cancels
 * are counted separately and deliberately kept OUT of the ratio's denominator:
 * canceling an issue does not do the work, and letting a cancel improve the
 * headline number is exactly the incentive that would make this metric lie.
 * They are reported alongside so a cancel-heavy week is still visible.
 *
 * ARCHIVED ISSUES ARE THE SUBTLE ONE. Linear's `issues` connection excludes
 * ARCHIVED issues by default, and scripts/linear-archive-done.js archives
 * every Done/Canceled issue older than 48h to stay under the free-tier
 * 250-unarchived cap. So the default view of "closed this week" silently
 * drops everything closed more than two days ago — measured live on
 * 2026-09-07, that hid 41 of 101 closures and 56 of 324 creations in a 7-day
 * window and turned a real 3.2:1 into a reported 4.4:1. The closure and
 * creation counts therefore pass `includeArchived: true`; the OPEN count
 * deliberately does not, because an archived issue is out of the working set
 * whatever state it carries. This is also why the 4.5:1 figure in the
 * 2026-09-08 plan is an overstatement — the direction and the decision it
 * drove both survive the correction, the headline number does not.
 *
 * Pure in, pure out — no fs, no clock, no network of its own. The GraphQL
 * transport is INJECTED (same shape as assessDelegations in
 * linear-delegation-health.js and pr-supervisor-core.js's verdicts) so the
 * whole policy is fixture-testable, and so the digest's 15s race can wrap it
 * from the outside without this module knowing what a timeout is.
 */

const { TERMINAL_STATE_TYPES } = require('./linear-state-types.js');

const TEAM_KEY = 'BRO';

// One week. The owner reads this daily; a 7-day trailing window is long
// enough that one quiet Sunday does not swing the verdict, and short enough
// that a fix to the inflow shows up within a week of landing.
const INFLOW_WINDOW_DAYS = 7;

// 250 nodes/page × 40 = 10,000 issues. The whole BRO team is ~2,200 issues
// ever, so this is unreachable in practice for a 7-day window and exists only
// so a malformed filter cannot spin forever inside a 7:30am email job.
const MAX_PAGES = 40;

// Backlog holds steady at 1.0. Slack above it because a session that
// legitimately finds three bugs while fixing one SHOULD file three — the
// metric is meant to catch a systemic drift, not to punish honest discovery.
const OK_MAX_RATIO = 1.5;
// Above this the backlog grows by roughly a hundred issues a week at current
// volume, which is the drift that produced the 1,072.
const WATCH_MAX_RATIO = 2.5;

// A week with 4 filed and 0 closed is a quiet week, not an emergency. Without
// this floor the row would cry wolf over holiday weeks and get ignored — the
// documented fate of the 21 unheeded email-worker alerts.
const MIN_CREATED_FOR_ALARM = 5;

/**
 * The exact query text sent over the wire. Exported so the test asserts on
 * the real string rather than a second, drifting copy of it (CLAUDE.md rule
 * 15) — the same reason linear-dispatch.js owns linear-client.js's query text.
 *
 * Only `id` is selected: this is a counter, and pulling titles/descriptions
 * for ~300 issues into a 7:30am email job is bandwidth for nothing.
 */
function buildInflowCountQuery() {
  return `query InflowCount($filter: IssueFilter, $after: String, $includeArchived: Boolean) {
  issues(filter: $filter, first: 250, after: $after, includeArchived: $includeArchived) {
    pageInfo { hasNextPage endCursor }
    nodes { id }
  }
}`;
}

/** ISO timestamp `windowDays` before `now`. */
function windowStart(now, windowDays = INFLOW_WINDOW_DAYS) {
  return new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000).toISOString();
}

function buildCreatedFilter(sinceIso, teamKey = TEAM_KEY) {
  return { team: { key: { eq: teamKey } }, createdAt: { gte: sinceIso } };
}

/**
 * Closed-as-DONE. `completedAt` is Linear's own field and is populated only
 * for completed-type states, so this needs no state-name list to drift.
 */
function buildCompletedFilter(sinceIso, teamKey = TEAM_KEY) {
  return { team: { key: { eq: teamKey } }, completedAt: { gte: sinceIso } };
}

/**
 * Cancels and duplicates. Confirmed live 2026-08-26 (see
 * linear-state-types.js): Linear populates `canceledAt` for duplicate-type
 * issues too, so this one filter covers both non-done terminal types.
 */
function buildCanceledFilter(sinceIso, teamKey = TEAM_KEY) {
  return { team: { key: { eq: teamKey } }, canceledAt: { gte: sinceIso } };
}

/** Everything not in one of the three terminal types. */
function buildOpenFilter(teamKey = TEAM_KEY) {
  return { team: { key: { eq: teamKey } }, state: { type: { nin: TERMINAL_STATE_TYPES } } };
}

/**
 * Walk every page of one filter and return how many issues matched.
 *
 * @param {object}   args
 * @param {Function} args.graphql  (query, variables) => Promise<data>
 * @param {object}   args.filter
 * @param {boolean}  [args.includeArchived]  see ARCHIVED ISSUES in the header
 * @param {number}   [args.maxPages]
 * @returns {Promise<{count:number, truncated:boolean, pages:number}>}
 *   `truncated` true means the walk stopped at maxPages and `count` is a
 *   FLOOR, not the answer.
 */
async function countMatching({ graphql, filter, includeArchived = false, maxPages = MAX_PAGES }) {
  const query = buildInflowCountQuery();
  let after = null;
  let count = 0;
  let pages = 0;
  for (;;) {
    const data = await graphql(query, { filter, after, includeArchived });
    const conn = data && data.issues;
    if (!conn || !Array.isArray(conn.nodes)) {
      throw new Error('Linear returned no issues connection for the inflow count');
    }
    count += conn.nodes.length;
    pages += 1;
    if (!conn.pageInfo || !conn.pageInfo.hasNextPage) return { count, truncated: false, pages };
    if (pages >= maxPages) return { count, truncated: true, pages };
    after = conn.pageInfo.endCursor;
  }
}

/**
 * Fetch the four counts the verdict needs. Sequential, not parallel: this
 * runs inside the morning digest's fail-soft block and four concurrent
 * paginated walks against a rate-limited API is a worse neighbour than four
 * sequential ones that finish in a couple of seconds.
 */
async function fetchInflowCounts({ graphql, now = new Date(), windowDays = INFLOW_WINDOW_DAYS, teamKey = TEAM_KEY, maxPages = MAX_PAGES } = {}) {
  const since = windowStart(now, windowDays);
  // includeArchived TRUE for the three closure/creation counts and FALSE for
  // the open count — see ARCHIVED ISSUES in the header. Getting this wrong is
  // not a rounding error: measured live 2026-09-07, the default (archived
  // excluded) hid 41 of 101 closures and 56 of 324 creations in a 7-day
  // window, reporting 4.4:1 for a board that was actually running 3.2:1.
  const created = await countMatching({ graphql, filter: buildCreatedFilter(since, teamKey), includeArchived: true, maxPages });
  const completed = await countMatching({ graphql, filter: buildCompletedFilter(since, teamKey), includeArchived: true, maxPages });
  const canceled = await countMatching({ graphql, filter: buildCanceledFilter(since, teamKey), includeArchived: true, maxPages });
  const open = await countMatching({ graphql, filter: buildOpenFilter(teamKey), includeArchived: false, maxPages });
  return {
    created: created.count,
    completed: completed.count,
    canceled: canceled.count,
    open: open.count,
    windowDays,
    since,
    truncated: created.truncated || completed.truncated || canceled.truncated || open.truncated,
  };
}

/**
 * The verdict. ALWAYS returns a message when it has usable counts — green as
 * well as red. That is deliberate and follows the trunk-status row's
 * precedent in the digest: a signal that renders only when it is angry
 * teaches the reader that its absence means "fine", which is
 * indistinguishable from "the collector died". The digest colours by
 * `status`; it does not decide whether to speak.
 *
 * @param {object} counts  as returned by fetchInflowCounts
 * @returns {{status:'ok'|'watch'|'error'|'unknown', ratio:number|null, message:string|null}}
 */
function assessInflowRatio(counts) {
  if (!counts || typeof counts !== 'object') {
    return { status: 'unknown', ratio: null, message: null };
  }
  const { created, completed, canceled = 0, open = null, windowDays = INFLOW_WINDOW_DAYS, truncated = false } = counts;
  if (!Number.isFinite(created) || !Number.isFinite(completed)) {
    return { status: 'unknown', ratio: null, message: null };
  }

  const days = `${windowDays} day${windowDays === 1 ? '' : 's'}`;
  const openPart = Number.isFinite(open) ? `${open} open. ` : '';
  const cancelPart = canceled > 0 ? ` (${canceled} more canceled)` : '';
  const ratio = completed > 0 ? created / completed : null;
  const shown = ratio === null ? null : Math.round(ratio * 10) / 10;

  // A truncated walk under-counts, and an under-count can only ever make the
  // board look healthier than it is. Say so instead of publishing the floor
  // as if it were the number.
  if (truncated) {
    return {
      status: 'unknown',
      ratio: shown,
      message: `Backlog inflow: the Linear count hit its page limit, so the last ${days} read as at least ${created} filed / ${completed} closed and the real ratio is worse than any number here.`,
    };
  }

  if (created === 0 && completed === 0) {
    return {
      status: 'ok',
      ratio: null,
      message: `Backlog inflow: ${openPart}nothing filed and nothing closed in the last ${days}.`,
    };
  }

  if (completed === 0) {
    const status = created >= MIN_CREATED_FOR_ALARM ? 'error' : 'watch';
    return {
      status,
      ratio: null,
      message: `Backlog inflow: ${openPart}${created} filed and NOTHING closed in the last ${days}${cancelPart}. The board is only growing.`,
    };
  }

  // Normalized to a week REGARDLESS of the window. The first version printed
  // the raw in-window delta and called it "a week", which read a 1-day sample
  // of +43 as "43 issues a week" (it is 301) and a 30-day sample of +1,077 the
  // same way. A rate the reader cannot trust across windows is worse than no
  // rate, because they will quote it.
  const perWeek = Math.round(((created - completed) * 7) / windowDays);
  const base = `Backlog inflow: ${openPart}${created} filed / ${completed} closed in the last ${days}${cancelPart} — ${shown} filed per 1 closed.`;
  if (ratio <= OK_MAX_RATIO) {
    return { status: 'ok', ratio: shown, message: `${base} Holding.` };
  }
  if (ratio <= WATCH_MAX_RATIO) {
    return { status: 'watch', ratio: shown, message: `${base} Drifting — the backlog grows about ${perWeek} issues a week at this rate.` };
  }
  return {
    status: 'error',
    ratio: shown,
    message: `${base} The backlog is growing about ${perWeek} issues a week at this rate. Fixing things instead of filing them is the lever.`,
  };
}

module.exports = {
  TEAM_KEY,
  INFLOW_WINDOW_DAYS,
  MAX_PAGES,
  OK_MAX_RATIO,
  WATCH_MAX_RATIO,
  MIN_CREATED_FOR_ALARM,
  buildInflowCountQuery,
  windowStart,
  buildCreatedFilter,
  buildCompletedFilter,
  buildCanceledFilter,
  buildOpenFilter,
  countMatching,
  fetchInflowCounts,
  assessInflowRatio,
};
