/**
 * backlog-drain.js — pure selection/metric logic for the backlog drain engine
 * (owner mandate 2026-07-30, task #654: "if [the backlog] isn't [draining],
 * it's not finished nor working"). bsc-next.js's default pick favors
 * Notion-priority order (P0/P1 first), which starves the machine-discovered
 * P2 tail (rage-click cards, UX audits, Missing show, BSC Daily items) —
 * some pending for weeks. This module picks the OLDEST eligible card from
 * the FULL pool (any priority) instead, for scripts/backlog-drain.js's
 * rate-limited launchd tick to dispatch through bsc-next's own machinery.
 *
 * Reuses two #635 (loop re-enable readiness) building blocks by CALLING
 * their real exported functions, not re-deriving the policy:
 *   - attempt-memory.js's checkPark — "failed twice unchanged → parked"
 *   - autonomous-budget.js's spendCircuitBreakerStatus — "spent $X with zero
 *     completions → halt"
 * Both were built for the (paused) nightly loop's own ledger
 * (autonomous-ledger.jsonl). Backlog-drain dispatches through bsc-next
 * --headless instead, which never writes to that ledger, so this module
 * feeds the SAME functions entries from backlog-drain's OWN ledger
 * (data/audit/backlog-drain-ledger.jsonl, shape-compatible: {cardId,
 * contentHash, event: 'card-pass'|'card-fail', usd}) — see
 * scripts/backlog-drain.js's reconcileOutcomes().
 */
'use strict';

const { checkPark, computeContentHash } = require('./attempt-memory.js');
const { spendCircuitBreakerStatus } = require('./autonomous-budget.js');
const { isExcludedCategory } = require('./autonomous-eligibility.js');
const dispatchLedger = require('./dispatch-ledger.js');

const DEFAULT_CONCURRENCY_CAP = 2;
const DEFAULT_SPEND_THRESHOLD_USD = 12;
const DEFAULT_SPEND_WINDOW_H = 24;
const DEFAULT_HISTORY_DAYS = 30;

// Same {name, notes} shape attempt-memory.computeContentHash expects —
// task-mirror shape uses {subject, description} instead of the Notion
// card's {name, notes}, so this is the one place the two vocabularies meet.
function taskContentHash(task) {
  return computeContentHash({ name: task && task.subject, notes: task && task.description });
}

function pendingTasks(tasks) {
  return (tasks || []).filter(t => t && t.status === 'pending');
}

// Human-territory exclusion for the drain path — same category predicate
// bsc-next's own default pick already uses (marketing/partnerships + short
// human-action imperatives like "Email volunteers"). A separate bucket in
// the metric, never silently dropped from the pending count.
function isHumanTask(task) {
  return isExcludedCategory(task);
}

// Cards the #646 verifiability audit flagged as unarmed (no runnable verify
// command AND no owner-judgment marker) — reuses that report instead of
// re-fetching every pending card's full notes on every tick just to count
// this bucket. refusedNotionIds is a Set of Notion page ids from
// card-verifiability.json's `refused` array.
function isAwaitingEnrichment(task, refusedNotionIds, notionIdOfFn) {
  const nid = notionIdOfFn(task);
  return !!(nid && refusedNotionIds && refusedNotionIds.has(nid));
}

// Attempt-memory (#635): a card that failed drain dispatch
// opts.maxFailures (default 2) times in a row with unchanged content is
// parked until it's edited or the owner clears the park. Returns
// Map<taskId(string), reason>.
function computeParkedMap(tasks, ledgerEntries, opts = {}) {
  const parked = new Map();
  for (const t of tasks || []) {
    const hash = taskContentHash(t);
    const r = checkPark(ledgerEntries, String(t.id), hash, opts);
    if (r.parked) parked.set(String(t.id), r.reason);
  }
  return parked;
}

// Oldest-eligible-first candidate order: lowest task id (creation order —
// NOT Notion priority) among pending, non-human, non-parked, non-in-flight,
// non-refused tasks. The caller still live-verify-gate-checks each in turn
// before dispatch (a card enriched an hour ago may not be in the static
// card-verifiability.json report yet) — this only orders/pre-filters the scan.
function candidateOrder(tasks, opts = {}) {
  const parked = opts.parkedIds || new Map();
  const refused = opts.refusedNotionIds || new Set();
  const inFlight = opts.inFlightIds || new Set();
  const notionIdOfFn = opts.notionIdOfFn || (() => null);
  return pendingTasks(tasks)
    .filter(t => !isHumanTask(t))
    .filter(t => !parked.has(String(t.id)))
    .filter(t => !inFlight.has(String(t.id)))
    .filter(t => !isAwaitingEnrichment(t, refused, notionIdOfFn))
    .sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10));
}

// Concurrency: how many drain-ORIGINATED jobs are currently alive, per
// dispatch-ledger.jsonl's shared job lifecycle (job-spawned with no
// terminal job-done/job-failed/job-orphaned/job-retried yet), restricted to
// taskIds THIS engine dispatched (drainDispatchedTaskIds) — never counts a
// manually-run `bsc-next --headless` job someone else started.
function computeConcurrency(drainDispatchedTaskIds, dispatchLedgerEntries, cap = DEFAULT_CONCURRENCY_CAP) {
  const jobs = dispatchLedger.foldJobs(dispatchLedgerEntries || []);
  const aliveTaskIds = [];
  for (const job of jobs.values()) {
    if (!drainDispatchedTaskIds || !drainDispatchedTaskIds.has(String(job.taskId))) continue;
    if (!dispatchLedger.TERMINAL_JOB_EVENTS.has(job.event)) aliveTaskIds.push(String(job.taskId));
  }
  return { alive: aliveTaskIds.length, cap, atCap: aliveTaskIds.length >= cap, aliveTaskIds };
}

// Spend circuit breaker (#635): reuses the exact halt semantics
// autonomous-budget.js's spendCircuitBreakerStatus enforces for the nightly
// loop (spent >= threshold with zero completions), windowed to backlog-
// drain's own ledger so a run of failed drain dispatches halts further
// attempts the same way a bad loop night would.
function computeSpendCircuitBreaker(drainLedgerEntries, opts = {}) {
  const thresholdUSD = Number.isFinite(opts.thresholdUSD) ? opts.thresholdUSD : DEFAULT_SPEND_THRESHOLD_USD;
  const windowH = Number.isFinite(opts.windowH) ? opts.windowH : DEFAULT_SPEND_WINDOW_H;
  const now = opts.now || Date.now();
  const cutoff = now - windowH * 3600e3;
  const windowed = (drainLedgerEntries || []).filter(e => e && e.ts && new Date(e.ts).getTime() >= cutoff);
  return spendCircuitBreakerStatus(windowed, { thresholdUSD });
}

// Metric math for the digest row. priorHistory is the trailing daily
// snapshot array from the PREVIOUS metric file ({date:'YYYY-MM-DD',
// pending}) — used to compute the net-drain-this-week delta. Returns the
// updated (trimmed) history for the caller to persist.
function computeDrainMetric(tasks, opts = {}) {
  const refusedNotionIds = opts.refusedNotionIds || new Set();
  const notionIdOfFn = opts.notionIdOfFn || (() => null);
  const parkedIds = opts.parkedIds || new Map();
  const priorHistory = Array.isArray(opts.priorHistory) ? opts.priorHistory : [];
  const now = opts.now || new Date();

  const pending = pendingTasks(tasks);
  const human = pending.filter(isHumanTask);
  const nonHuman = pending.filter(t => !isHumanTask(t));
  const parked = nonHuman.filter(t => parkedIds.has(String(t.id)));
  const awaitingEnrichment = nonHuman.filter(t =>
    !parkedIds.has(String(t.id)) && isAwaitingEnrichment(t, refusedNotionIds, notionIdOfFn));

  const today = now.toISOString().slice(0, 10);
  const history = priorHistory.filter(h => h && h.date && h.date !== today);
  history.push({ date: today, pending: pending.length });
  history.sort((a, b) => (a.date < b.date ? -1 : 1));
  const trimmed = history.slice(-DEFAULT_HISTORY_DAYS);

  // Closest entry AT OR BEFORE (today - 7d), tolerant of a missed tick day —
  // walking ascending and keeping the last match lands on the nearest one.
  const weekAgoTarget = new Date(now.getTime() - 7 * 86400e3).toISOString().slice(0, 10);
  let weekAgoEntry = null;
  for (const h of trimmed) {
    if (h.date <= weekAgoTarget) weekAgoEntry = h;
  }
  // Signed so it can be printed directly ("net -4 this week" = shrank by 4,
  // "net +6 this week" = grew by 6). null until a week of history exists.
  const netDrainWeek = weekAgoEntry ? (pending.length - weekAgoEntry.pending) : null;

  return {
    generatedAt: now.toISOString(),
    pending: pending.length,
    humanWaiting: human.length,
    parked: parked.length,
    awaitingEnrichment: awaitingEnrichment.length,
    netDrainWeek,
    history: trimmed,
  };
}

function formatBannerText(metric) {
  const sub = [];
  if (metric.netDrainWeek !== null && metric.netDrainWeek !== undefined) {
    sub.push(`net ${metric.netDrainWeek >= 0 ? '+' : ''}${metric.netDrainWeek} this week`);
  }
  if (metric.parked) sub.push(`${metric.parked} parked as failed-twice`);
  if (metric.awaitingEnrichment) sub.push(`${metric.awaitingEnrichment} awaiting enrichment`);
  if (metric.humanWaiting) sub.push(`${metric.humanWaiting} waiting on owner`);
  return sub.length ? `${metric.pending} pending (${sub.join(', ')})` : `${metric.pending} pending`;
}

module.exports = {
  DEFAULT_CONCURRENCY_CAP,
  DEFAULT_SPEND_THRESHOLD_USD,
  DEFAULT_SPEND_WINDOW_H,
  DEFAULT_HISTORY_DAYS,
  taskContentHash,
  pendingTasks,
  isHumanTask,
  isAwaitingEnrichment,
  computeParkedMap,
  candidateOrder,
  computeConcurrency,
  computeSpendCircuitBreaker,
  computeDrainMetric,
  formatBannerText,
};
