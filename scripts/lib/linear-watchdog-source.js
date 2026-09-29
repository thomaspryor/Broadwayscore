/**
 * linear-watchdog-source.js — Linear as the P0/P1 backlog source for
 * dispatch-watchdog.js (BRO-3390).
 *
 * WHY THIS EXISTS. dispatch-watchdog.js --dashboard is the only continuous,
 * always-on, top-up dispatcher in the fleet: it sweeps every 90s, re-dispatches
 * ledger-confirmed-dead work and drains undispatched P0/P1 cards (standing
 * owner rule 2026-07-24). It has been running unattended since 2026-09-07.
 *
 * It has also been pointed at a board nobody uses. Its task source is
 * audit-dispatch-outcomes.js's loadTasksUnioned(), which reads ONLY
 * ~/.claude/tasks/<list>/<digits>.json — the Notion mirror, which froze at task
 * id 1285 on 2026-08-20 (CLAUDE.md §6). Measured 2026-09-15: of the 180
 * `watchdog-redispatch` rows written since 2026-09-01, 180 carry Notion-numeric
 * taskIds and ZERO carry a `linear:` id; two ids in its own awaitingClaim list
 * (1889, 1226) have no task file at all. Meanwhile the live Linear board held
 * 1002 open issues, 684 of them armed with a safe verify command and reachable
 * by no continuous drain whatsoever. That is the whole of "we've made no
 * progress in many weeks": the drain runs every 90 seconds, spends its entire
 * 12/day budget, and spends it on a retired board.
 *
 * This module is the second source. It mirrors the structure of
 * linear-recheck-source.js (BRO-3373), which solved the identical
 * frozen-mirror problem for the nightly acceptance recheck — mapIssueToTask is
 * PURE (no I/O) so the whole selection path is testable with a plain fixture
 * object and no network stub, and the one function that talks to Linear never
 * throws but also never swallows a real failure into a silent empty array.
 * That last distinction matters more here than it did there: an empty array
 * returned on a Linear outage would read to planSweep() as "no P0/P1 work
 * exists" and silently idle the drain, which is exactly the failure this
 * module was written to end. Callers get {tasks, ok, reason} and are expected
 * to leave the Notion-sourced half of the sweep running when ok === false.
 *
 * ELIGIBILITY IS DELIBERATELY NARROWER THAN "OPEN". Two filters beyond state:
 *
 *   1. ARMED ONLY (hasSafeVerifyCommand). linear-next.js's verify gate refuses
 *      a --headless dispatch that has no machine-checkable proof of done. The
 *      watchdog's day budget counts CLAIMS, not successes
 *      (dispatch-watchdog-core.js's watchdogClaimsToday) — so queueing unarmed
 *      cards would burn the full 12/day on dispatches that are refused inside
 *      the detached child, with zero work done and nothing in the ledger to
 *      say why. Gate here, where the queue is built, not there.
 *   2. NOT AN AUTOFIX-FILED TRACKER. scripts/linear-drain-parked.js already
 *      owns that population (auto-filed "BSC Daily:"/CANARY trackers) and
 *      dispatches it WITH {allowAutofixFiled: true}. The watchdog passes no
 *      such waiver, so autofixFiledIssueGuard (linear-dispatch.js:544) would
 *      refuse those cards anyway — and that guard is precisely the
 *      collision-avoidance between the two drains. It only works while the two
 *      populations stay disjoint, so this module keeps them disjoint at the
 *      source rather than relying on a refusal downstream.
 *
 * PRIORITY. This module builds its own query (same reason
 * linear-recheck-source.js builds buildRecheckCandidatesQuery rather than
 * widening a shared one; buildOpenIssuesWithDescriptionsQuery has since
 * grown a `priority` field too — BRO-3913 — so enrich-card-acceptance.js can
 * sweep in the same P0/P1-first order this module drains).
 * Linear's numeric priority is authoritative when set (1 = Urgent → P0,
 * 2 = High → P1); a "P0:"/"P1:" title prefix is the fallback for the many
 * hand-filed cards that encode priority in the title and leave the field at
 * No priority. Anything else is not queued at all — planSweep only ever
 * dispatched P0/P1 and this module does not widen that mandate.
 */

'use strict';

const { evaluateVerifiability } = require('./verify-gate.js');
const { isAutofixFiledIssue } = require('./autofix-filed-marker.js');
const { isTerminalStateType, TERMINAL_STATE_TYPES } = require('./linear-state-types.js');
const { classifyHeadlessDispatchability } = require('./headless-dispatchability.js');

// The id namespace planSweep and the shared dispatch ledger already speak:
// digest-autofix.js:415 forks on exactly this shape to choose linear-next.js
// over bsc-next.js, and every `launch`/`job-*` row written for a Linear card
// since the migration carries it. Reusing it means no ledger correlation,
// park bookkeeping or concurrency fold needs to learn a new id format.
// BRO-3423: this shape used to be declared here AND, differently, in
// digest-autofix.js (/^linear:([A-Z]+-\d+)$/, which rejects a team key with a
// digit in it). Both now come from the one module that declares which board is
// live and which is retired — re-exported here so this module's own consumers
// and tests keep importing it from the same place they always have.
const {
  LINEAR_TASK_PREFIX,
  LINEAR_TASK_ID_RE,
} = require('./task-id-namespace.js');

// Linear's numeric priority field. 0 = No priority, 1 = Urgent, 2 = High,
// 3 = Medium, 4 = Low. Only the top two map onto the watchdog's P0/P1 mandate.
const LINEAR_PRIORITY_TO_LABEL = Object.freeze({ 1: 'P0', 2: 'P1' });

// Fallback for hand-filed cards that put the priority in the title and leave
// the field at No priority ("P0: launchCmuxSession reports ok:true ...").
// Anchored, and tolerant of both "P1:" and "P1 " — the same two shapes
// dispatch-watchdog-core.js's own subject fallback already accepts.
const TITLE_PRIORITY_RE = /^\s*(P[01])\b/;

const DEFAULT_PAGE_LIMIT = 100;
const DEFAULT_MAX_PAGES = 30;

function linearTaskId(identifier) {
  return `${LINEAR_TASK_PREFIX}${identifier}`;
}

function parseLinearTaskId(taskId) {
  const m = LINEAR_TASK_ID_RE.exec(String(taskId || ''));
  return m ? m[1] : null;
}

function isLinearTaskId(taskId) {
  return LINEAR_TASK_ID_RE.test(String(taskId || ''));
}

/**
 * Own query: identical filter to buildOpenIssuesWithDescriptionsQuery (team +
 * non-terminal state) with a configurable page size; both select `priority`.
 */
function buildWatchdogBacklogQuery(pageLimit = DEFAULT_PAGE_LIMIT) {
  const limit = Number.isInteger(pageLimit) && pageLimit > 0 ? pageLimit : DEFAULT_PAGE_LIMIT;
  return `query($teamKey: String!, $after: String) {
    issues(
      first: ${limit}
      after: $after
      filter: {
        team: { key: { eq: $teamKey } }
        state: { type: { nin: ${JSON.stringify(TERMINAL_STATE_TYPES)} } }
      }
    ) {
      nodes {
        identifier
        title
        description
        priority
        url
        state { name type }
      }
      pageInfo { hasNextPage endCursor }
    }
  }`;
}

/**
 * PURE. Linear's numeric priority field is authoritative. The "P0:"/"P1:"
 * title prefix is consulted ONLY when the field is unset (0 / null).
 *
 * Ship-check (Codex) caught the earlier version falling back to the title for
 * Medium and Low too: an issue somebody had DELIBERATELY downgraded to Low
 * while its title still read "P0: ..." would have been queued as urgent and
 * spent the day budget on work the owner had just deprioritised. An explicit
 * priority is a decision; the title is only a guess at one.
 */
function priorityOf(issue) {
  if (!issue) return null;
  const fromField = LINEAR_PRIORITY_TO_LABEL[issue.priority];
  if (fromField) return fromField;
  const explicitlyRanked = Number.isFinite(issue.priority) && issue.priority > 0;
  if (explicitlyRanked) return null;     // Medium/Low: a real decision, don't override it
  const m = TITLE_PRIORITY_RE.exec(String(issue.title || ''));
  return m ? m[1] : null;
}

/** PURE. Does this issue carry a machine-checkable proof of done? */
function hasSafeVerifyCommand(issue) {
  if (!issue) return false;
  return !!evaluateVerifiability(String(issue.description || '')).cmd;
}

/**
 * PURE. The full "should the watchdog queue this" predicate, split out so a
 * test can assert each reason independently. Returns a reason string when the
 * issue is NOT eligible, or null when it is.
 *
 * @param {object} issue
 * @param {object} [opts]
 * @param {Set<string>} [opts.alreadyPassesIds]  Linear identifiers (e.g.
 *   "BRO-1234") that BRO-3551's own sweep (scripts/sweep-open-backlog-
 *   acceptance.js) already found passing their OWN acceptance command on
 *   main. Injected by the caller (dispatch-watchdog.js reads
 *   data/audit/open-backlog-acceptance-sweep.json — I/O — and passes the id
 *   set in here), same pattern as planSweep's own `recheckFailures` opt —
 *   this module stays pure and never touches the filesystem itself, and
 *   never re-runs the acceptance command (BRO-3924: "never run runVerify
 *   inside the 90s watchdog loop").
 */
function ineligibleReason(issue, opts = {}) {
  if (!issue || !issue.identifier) return 'malformed';
  const stateType = issue.state && issue.state.type;
  if (!stateType) return 'no-state';
  // Terminal states are already excluded by the query's own filter in
  // production; re-checked here so mapIssueToTask is safe on any fixture and
  // so a query change can never silently start queueing closed work.
  if (isTerminalStateType(stateType)) return 'terminal-state';
  // 'started' = In Progress / In Review. Those already have (or had) a session
  // on them; linear-dispatch.js's startedStateGuard refuses them, so queueing
  // one burns a claim for a guaranteed refusal.
  if (stateType === 'started') return 'already-started';
  if (!priorityOf(issue)) return 'not-p0-p1';
  if (isAutofixFiledIssue(issue)) return 'autofix-filed-tracker';
  // BRO-3924 (R3): checked BEFORE the armed/headless checks below —
  // sweep-open-backlog-acceptance.js only ever records an id in its
  // `alreadyDone` report after confirming it clears BOTH of those gates
  // itself (selectOpenBacklogSweepCandidates requires an armed verify
  // command AND classifyHeadlessDispatchability), so an id present here is
  // guaranteed to reach 'unarmed'/'headless-blocked' anyway — this ordering
  // is a pure short-circuit, not a behavior change. A card that regressed
  // since the sweep ran (edited, re-armed differently) still reports
  // 'already-passes' until the NEXT sweep refreshes the report — the same
  // staleness window recheckFailures already tolerates.
  if (opts.alreadyPassesIds && opts.alreadyPassesIds.has(issue.identifier)) return 'already-passes';
  const gate = evaluateVerifiability(String(issue.description || ''));
  if (!gate.cmd) return 'unarmed';
  // Ship-check (Codex): being ARMED is necessary but not sufficient. linear-next
  // refuses a headless dispatch for several further reasons (the PARKED
  // sentinel, visual-QA and other human gates). The day budget counts CLAIMS,
  // not successes, so queueing one of those spends real allowance on a
  // guaranteed refusal whose only trace is the detached child's own log. Reuse
  // the SAME predicate the dispatcher enforces (backlog-drain.js:547 already
  // calls it at its own queue-build), rather than a second copy of the rules.
  const headless = classifyHeadlessDispatchability(
    { subject: issue.title, notes: issue.description }, { verifyCmd: gate.cmd });
  if (!headless.dispatchable) return `headless-blocked: ${headless.blockers.map(b => b.code).join(',')}`;
  return null;
}

function isWatchdogEligible(issue, opts) {
  return ineligibleReason(issue, opts) === null;
}

/**
 * PURE. Map a Linear issue onto the task-mirror shape planSweep() consumes:
 * {id, subject, description, status}.
 *
 * The description's first line deliberately mirrors notion-tasks-sync's
 * "[notion:<id>] P1 Next · Not started · <category>" convention so that
 * dispatch-watchdog-core.js's taskPriority() parses it with one widened
 * regex instead of a second code path. The REST of the original description is
 * preserved verbatim underneath, because isExcludedCategory() reads it for the
 * owner-judgment marker and verify-gate.js reads it for the acceptance command.
 */
/**
 * PURE. Map a `started` map entry (identifier/title/stateName — the shape
 * fetchLinearWatchdogTasks() stores for In Progress / In Review issues) onto
 * the same task-mirror shape planSweep() consumes.
 *
 * BRO-3424 (ship-check catch, Codex): started issues are deliberately kept
 * OUT of the queue-eligible `tasks` map above (isWatchdogEligible excludes
 * them — they're already being worked and must never be re-queued), but that
 * left them with NO entry anywhere dispatch-watchdog-core.js's planSweep()
 * could see — so a headless job whose Linear card was still "In Progress"
 * (exactly the state of a job that finished without merging) had
 * `tasks.get(id)` return undefined, and its unlandedDone finding was silently
 * dropped for the card's own primary real-world case. status:'in_progress'
 * is deliberate — it's the other value isTaskOpen() accepts besides
 * 'pending', and p01Queue only re-queues 'pending', so this can never cause
 * a started card to be redispatched.
 */
function mapStartedToTask(id, meta) {
  if (!id || !meta) return null;
  return {
    id, subject: meta.title || meta.identifier || id,
    description: `[linear:${meta.identifier}] · ${meta.stateName || 'Unknown'} · no-category\n`,
    status: 'in_progress',
  };
}

function mapIssueToTask(issue) {
  if (!issue || !issue.identifier) return null;
  const priority = priorityOf(issue);
  if (!priority) return null;
  const stateName = (issue.state && issue.state.name) || 'Unknown';
  const body = String(issue.description || '');
  return {
    id: linearTaskId(issue.identifier),
    subject: String(issue.title || issue.identifier),
    description: `[linear:${issue.identifier}] ${priority} Next · ${stateName} · no-category\n${body}`,
    status: 'pending',
    linearIdentifier: issue.identifier,
    url: issue.url || null,
  };
}

/**
 * The one function that talks to Linear.
 *
 * NEVER throws — a Linear outage must leave the Notion-sourced half of the
 * sweep working rather than take the dashboard down. But it never reports an
 * outage as an empty result either: {ok:false, reason} is the signal callers
 * must branch on. Returning [] on failure would read as "no P0/P1 work exists"
 * and silently idle the very drain this module exists to feed.
 *
 * @returns {Promise<{ok: boolean, reason: string|null, tasks: Map<string,object>, scanned: number, eligible: number}>}
 */
async function fetchLinearWatchdogTasks(client, opts = {}) {
  const tasks = new Map();
  // Issues in a started state (In Progress / In Review) are NOT queueable, but
  // they are exactly the population the write-back leak detector needs, and
  // they arrive in this same scan — collecting them here costs nothing extra.
  const started = new Map();
  const maxPages = Number.isInteger(opts.maxPages) && opts.maxPages > 0 ? opts.maxPages : DEFAULT_MAX_PAGES;
  const teamKey = opts.teamKey || 'BRO';
  let scanned = 0;
  let after = null;

  if (!client || typeof client.graphql !== 'function') {
    return { ok: false, reason: 'no-linear-client', tasks, scanned: 0, eligible: 0 };
  }

  try {
    for (let page = 0; page < maxPages; page++) {
      const data = await client.graphql(buildWatchdogBacklogQuery(opts.pageLimit), { teamKey, after });
      const nodes = (data && data.issues && data.issues.nodes) || [];
      const pageInfo = (data && data.issues && data.issues.pageInfo) || { hasNextPage: false };
      for (const issue of nodes) {
        scanned++;
        if (issue && issue.state && issue.state.type === 'started' && issue.identifier) {
          started.set(linearTaskId(issue.identifier), {
            identifier: issue.identifier,
            title: issue.title || issue.identifier,
            stateName: (issue.state && issue.state.name) || 'Unknown',
          });
        }
        if (!isWatchdogEligible(issue, opts)) continue;
        const task = mapIssueToTask(issue);
        if (task) tasks.set(task.id, task);
      }
      if (!pageInfo.hasNextPage) break;
      after = pageInfo.endCursor;
      if (page === maxPages - 1) {
        // Ship-check (Codex): stopping at the page cap while hasNextPage is
        // still true used to return ok:true with a silently truncated queue —
        // indistinguishable from a small backlog. Report it as an outage
        // instead; an understated queue is how a drain quietly idles.
        return {
          ok: false,
          reason: `linear-scan-truncated: hit maxPages=${maxPages} with more pages remaining`,
          tasks: new Map(), started: new Map(), scanned, eligible: 0,
        };
      }
    }
  } catch (e) {
    // Partial pages already collected are DISCARDED, not returned: a truncated
    // queue looks identical to a small backlog and would quietly narrow the
    // drain's view of its own work.
    return {
      ok: false,
      reason: `linear-fetch-failed: ${e && e.message ? e.message : String(e)}`,
      tasks: new Map(),
      started: new Map(),
      scanned,
      eligible: 0,
    };
  }

  return { ok: true, reason: null, tasks, started, scanned, eligible: tasks.size };
}

// ── write-back leak detection (BRO-3390) ───────────────────────────────────
//
// THE SEAM. A dispatched session is supposed to finish by moving its Linear
// card out of In Progress (linear-brain.js update --state Done|Paused). When
// it doesn't, the job still writes `job-done` to the dispatch ledger, so the
// work IS complete and the board says otherwise — the card sits In Progress
// forever and the owner sees no progress. Measured 2026-09-15 across 327
// issues with a job-done since 2026-08-16: 218 (66.7%) reached a completed
// state, 109 (33.3%) did not (95 In Progress, 11 In Review, 3 Todo). Weekly
// the rate is improving (47% → 77% → 90% → 78% → 82%), so this is a real but
// shrinking leak — NOT the 70%-broken seam the 2026-09-15 handoff claimed.
//
// This detector exists so the remainder stops being SILENT. It is pure: the
// caller passes the ledger entries and the started-issue map from the scan it
// already did. GRACE_MS is deliberately generous — a session legitimately
// takes minutes to write its report after job-done, and a false "leak" here
// would be noise on the one channel the owner actually reads.
const WRITEBACK_GRACE_MS = 6 * 3600 * 1000;

function detectWriteBackLeak(entries, startedIssues, now = Date.now(), graceMs = WRITEBACK_GRACE_MS) {
  const started = startedIssues instanceof Map ? startedIssues : new Map();
  if (!started.size) return [];
  const nowMs = new Date(now).getTime();
  // Latest job-done per task id.
  const lastDone = new Map();
  for (const e of entries || []) {
    if (!e || e.event !== 'job-done' || !e.taskId || !e.ts) continue;
    const id = String(e.taskId);
    if (!started.has(id)) continue;
    const t = new Date(e.ts).getTime();
    if (!Number.isFinite(t)) continue;
    if (!lastDone.has(id) || t > lastDone.get(id)) lastDone.set(id, t);
  }
  const leaked = [];
  for (const [id, doneMs] of lastDone) {
    const ageMs = nowMs - doneMs;
    if (ageMs < graceMs) continue;
    const meta = started.get(id);
    leaked.push({
      taskId: id,
      identifier: meta.identifier,
      title: meta.title,
      stateName: meta.stateName,
      doneAt: new Date(doneMs).toISOString(),
      ageHours: Math.round(ageMs / 3600000),
    });
  }
  leaked.sort((a, b) => b.ageHours - a.ageHours);
  return leaked;
}

module.exports = {
  WRITEBACK_GRACE_MS,
  detectWriteBackLeak,
  LINEAR_TASK_PREFIX,
  LINEAR_TASK_ID_RE,
  LINEAR_PRIORITY_TO_LABEL,
  TITLE_PRIORITY_RE,
  linearTaskId,
  parseLinearTaskId,
  isLinearTaskId,
  buildWatchdogBacklogQuery,
  priorityOf,
  hasSafeVerifyCommand,
  ineligibleReason,
  isWatchdogEligible,
  mapIssueToTask,
  mapStartedToTask,
  fetchLinearWatchdogTasks,
};
