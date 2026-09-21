'use strict';

/**
 * linear-drain-throughput.js — one throughput line for the morning digest:
 * how many cards actually reached Done per day, how many P0/P1 issues the
 * watchdog currently considers dispatchable, and how many Urgent/High
 * issues sit un-armed (no machine-checkable verify command) waiting on
 * someone to add one (BRO-3923 R6).
 *
 * WHY THIS SOURCE, NOT THE OBVIOUS ONES. scripts/audit-dispatch-outcomes.js
 * reads the frozen Notion mirror (CLAUDE.md §6) and ignores status/priority
 * flags — it cannot answer "how much real board work closed today". The
 * shared dispatch ledger's `job-done` event is not a card closing either:
 * linear-watchdog-source.js's own write-back-leak detector measured 33% of
 * `job-done` sessions never moving their Linear card out of an open state
 * (109 of 327, 2026-09-15) — counting ledger job-done as "drained" would
 * overstate throughput by that same margin. The only ground truth for "a
 * card is actually Done" is Linear's own `completedAt` field, read directly
 * from issue history — the same source scripts/lib/backlog-inflow-ratio.js
 * already fetches every morning for its created/closed ratio (BRO-3017);
 * `doneRatePerDay` below is a pure re-derivation of that SAME fetched
 * `completed`/`windowDays` pair, not a second live query.
 *
 * Pure decision functions only (CLAUDE.md §15) — no fs, no network. The two
 * network reads this metric needs (the completed-issue count, and the open
 * Urgent/High scan for the unarmed count) are done by the caller
 * (send-morning-digest.js, which already holds a live Linear client) via
 * fetchUnarmedUrgentHighCount below; the watchdog-eligible count is read by
 * the caller from the dispatch-watchdog heartbeat file the live 👑 OWNER
 * watchdog tab already writes every ~90s (dispatch-watchdog.js's
 * writeHeartbeat) — reusing that avoids a THIRD live Linear query for a
 * number that process already computes continuously.
 */

const { ineligibleReason } = require('./linear-watchdog-source.js');
const { buildOpenIssuesWithDescriptionsQuery } = require('./linear-dispatch.js');

const DEFAULT_MAX_PAGES = 30; // 100/page = 3,000 issues; the open board measured ~1,000 (BRO-3390 header).

// Same reasoning as backlog-inflow-ratio.js's own DIGEST_GRAPHQL_OPTS: this
// runs inside the 7:30am digest's fail-soft block, so a degraded Linear API
// should return quickly rather than exhausting linear-client's own default
// (5 attempts, up to 60s backoff each). Note this bounds each REQUEST, not
// the whole paginated walk — the caller's own Promise.race timeout is what
// bounds the walk (same limitation backlog-inflow-ratio.js accepts: a raced
// timeout rejects the wait but cannot cancel an in-flight request).
const DIGEST_GRAPHQL_OPTS = { maxAttempts: 2, timeoutMs: 6_000, baseMs: 250 };

// Same bar dispatch-watchdog.js's own HEALTH_STALE_MS uses to decide the
// watchdog itself is dead and page the owner (that constant isn't exported,
// so this is a deliberate duplicate of the VALUE, not an import — if the
// watchdog's own bar ever moves, re-check this one too). Below this age the
// heartbeat's linearSource.eligible reflects a scan from a live process;
// past it, the process may be dead and the number frozen — reported as n/a
// rather than a confidently-wrong stale count.
const HEARTBEAT_STALE_MS = 30 * 60 * 1000;

/** PURE. Is a heartbeat timestamp (ISO string) fresh enough to trust? */
function isHeartbeatFresh(ts, { nowMs = Date.now(), staleMs = HEARTBEAT_STALE_MS } = {}) {
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return false;
  return nowMs - t < staleMs;
}

/**
 * PURE. Done cards per local day, from an already-fetched completed count
 * over `windowDays`. `truncated:true` (backlog-inflow-ratio.js's
 * fetchInflowCounts sets this when its own completed-count page walk hit
 * MAX_PAGES with more pages outstanding — a FLOOR, not the real count) must
 * suppress the rate rather than silently present an undercount as an exact
 * measurement (ship-check/Codex finding, BRO-3923).
 */
function doneRatePerDay(completed, windowDays, { truncated = false } = {}) {
  if (truncated) return null;
  if (!Number.isFinite(completed) || !Number.isFinite(windowDays) || windowDays <= 0) return null;
  return Math.round((completed / windowDays) * 10) / 10;
}

/**
 * PURE. How many OPEN Urgent/High issues have no machine-checkable
 * acceptance command — reuses linear-watchdog-source.js's own
 * ineligibleReason() so "unarmed" can never mean something different here
 * than it does at the watchdog's own dispatch-eligibility gate (that
 * function already scopes to Urgent/High: every earlier branch — terminal
 * state, already-started, not-P0/P1, autofix-filed tracker — returns before
 * the 'unarmed' check ever runs).
 */
function countUnarmedUrgentHigh(issues) {
  if (!Array.isArray(issues)) return null;
  return issues.filter((issue) => ineligibleReason(issue) === 'unarmed').length;
}

/**
 * The one function that talks to Linear for this metric. Never throws — a
 * Linear outage must degrade this one digest line, not the whole send (same
 * contract as fetchLinearWatchdogTasks/fetchLinearRecheckCandidates).
 * `truncated: true` (via `ok:false`) means the page cap was hit with more
 * pages outstanding — reported rather than returning an undercount that
 * reads as a healthy small number.
 *
 * @returns {Promise<{ok:boolean, reason:string|null, count:number|null}>}
 */
async function fetchUnarmedUrgentHighCount({ graphql, teamKey = 'BRO', maxPages = DEFAULT_MAX_PAGES, graphqlOpts = DIGEST_GRAPHQL_OPTS } = {}) {
  if (!graphql || typeof graphql !== 'function') {
    return { ok: false, reason: 'no-linear-client', count: null };
  }
  const query = buildOpenIssuesWithDescriptionsQuery();
  const issues = [];
  let after = null;
  try {
    for (let page = 0; page < maxPages; page++) {
      const data = await graphql(query, { teamKey, after }, graphqlOpts);
      const conn = data && data.issues;
      // A malformed/shape-shifted response must be a reported failure, not a
      // silent "zero unarmed issues" (ship-check/Codex finding, BRO-3923) —
      // same validation backlog-inflow-ratio.js's countMatching already
      // applies to this exact client.
      // pageInfo missing entirely (not just hasNextPage:false) is ALSO
      // malformed — a genuinely-done page always carries a pageInfo object
      // (codex re-review finding: `{issues:{nodes:[]}}` with no pageInfo at
      // all used to read as "0 unarmed, scan complete" instead of a failure).
      if (!conn || !Array.isArray(conn.nodes) || !conn.pageInfo || typeof conn.pageInfo !== 'object') {
        return { ok: false, reason: 'malformed-response: missing issues.nodes or issues.pageInfo', count: null };
      }
      const pageInfo = conn.pageInfo;
      issues.push(...conn.nodes);
      if (!pageInfo.hasNextPage) return { ok: true, reason: null, count: countUnarmedUrgentHigh(issues) };
      after = pageInfo.endCursor;
      if (page === maxPages - 1) {
        return { ok: false, reason: `linear-scan-truncated: hit maxPages=${maxPages} with more pages remaining`, count: null };
      }
    }
  } catch (e) {
    return { ok: false, reason: `linear-fetch-failed: ${e && e.message ? e.message : String(e)}`, count: null };
  }
  return { ok: true, reason: null, count: countUnarmedUrgentHigh(issues) };
}

/**
 * PURE. One plain-text line for the morning digest. Any missing input
 * renders as "n/a" rather than dropping the whole line — a metric that
 * disappears on partial failure reads as "nothing to report" instead of
 * "half of this could not be measured", which is the exact silent-failure
 * shape this ticket's own incident (31 mis-filed trackers going unnoticed
 * for a day) grew out of.
 */
function formatDrainThroughputLine({ donePerDay = null, windowDays = 7, eligible = null, eligibleOk = false, unarmedCount = null } = {}) {
  const doneText = Number.isFinite(donePerDay) ? `${donePerDay}/day` : 'n/a';
  const eligibleText = eligibleOk && Number.isFinite(eligible) ? String(eligible) : 'n/a';
  const unarmedText = Number.isFinite(unarmedCount) ? String(unarmedCount) : 'n/a';
  const days = Number.isFinite(windowDays) ? windowDays : 7;
  // "armed and eligible", not "about to run" (ship-check/Codex finding,
  // BRO-3923): this is linearSource.eligible straight off the heartbeat —
  // isWatchdogEligible alone, before budgets/concurrency/kill-switch/outage
  // holds (dispatch-watchdog-core.js's dispatchCapDecision etc.) are applied.
  // A globally-paused watchdog can still report a healthy eligible count
  // here; the wording says "eligible", never "queued to run" or "in queue".
  return `Linear drain: ${doneText} Done (${days}d avg) · ${eligibleText} Linear P0/P1 armed+eligible · ${unarmedText} Urgent/High unarmed (no verify command)`;
}

module.exports = {
  DEFAULT_MAX_PAGES,
  DIGEST_GRAPHQL_OPTS,
  HEARTBEAT_STALE_MS,
  isHeartbeatFresh,
  doneRatePerDay,
  countUnarmedUrgentHigh,
  fetchUnarmedUrgentHighCount,
  formatDrainThroughputLine,
};
