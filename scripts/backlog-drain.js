#!/usr/bin/env node
/**
 * backlog-drain.js — rate-limited whole-pool dispatch (task #654, owner
 * mandate 2026-07-30). Run N times/day (launchd, DISABLED by default — see
 * scripts/launchd/com.broadwayscore.backlog-drain.plist), each tick:
 *
 *   1. Reconciles prior drain dispatches into pass/fail outcomes (by
 *      checking bsc-runner's job lifecycle + whether the task got marked
 *      completed), feeding scripts/lib/attempt-memory.js's checkPark so a
 *      card that fails drain twice unchanged gets parked (#635).
 *   2. Refuses to dispatch further if K drain-originated jobs are already
 *      alive, or the spend circuit breaker has tripped (#635).
 *   3. Otherwise picks the OLDEST eligible pending card from the FULL pool
 *      (any priority — not just P0/P1) and dispatches it through bsc-next's
 *      own --headless path (a detached subprocess, never a copy of its
 *      dispatch/verify-gate/duplicate-guard logic — see the header note on
 *      why this is a subprocess rather than a require()'d main() call).
 *   4. Always recomputes and writes the digest metric snapshot
 *      (data/audit/backlog-drain-metric.json), registered in
 *      scripts/lib/digest-snapshots.js so send-morning-digest.js renders it.
 *
 * bsc-next.js's main() calls process.exit(1) directly on several refusal
 * paths (verify-gate refusal, dead-dispatch guard, duplicate-workspace
 * guard) — calling it in-process via require() would kill THIS
 * orchestrator's process on any of those paths, before the metric snapshot
 * or ledger write ever happens. So the actual dispatch invocation goes
 * through a detached `node scripts/bsc-next.js --id N --headless` child
 * process (the canonical script, unmodified — never a reimplementation of
 * its guards); only bsc-next's PURE helpers (loadTasks, notionIdOf — no
 * process.exit in either) are require()'d directly.
 *
 * Usage:
 *   node scripts/backlog-drain.js               reconcile + maybe dispatch one card + write metric
 *   node scripts/backlog-drain.js --dry-run      same selection logic, no dispatch, no ledger/metric writes
 *   node scripts/backlog-drain.js --cap N        override concurrency cap (default 2)
 *   node scripts/backlog-drain.js --spend-threshold N   override circuit-breaker $ threshold (default 12)
 *   --help, -h   show this message, do nothing else
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');

const REPO = '/Users/tompryor/Broadwayscore';
const LIST_ID = process.env.CLAUDE_CODE_TASK_LIST_ID || 'broadwayscore';
const TASKS_DIR = path.join(os.homedir(), '.claude', 'tasks', LIST_ID);

const { loadTasks, notionIdOf } = require('./bsc-next.js');
const dispatchLedger = require('./lib/dispatch-ledger.js');
const { evaluateVerifiability } = require('./lib/verify-gate.js');
const {
  DEFAULT_CONCURRENCY_CAP,
  DEFAULT_SPEND_THRESHOLD_USD,
  taskContentHash,
  computeParkedMap,
  candidateOrder,
  computeConcurrency,
  computeSpendCircuitBreaker,
  computeDrainMetric,
  formatBannerText,
} = require('./lib/backlog-drain.js');

const AUDIT_DIR = path.join(REPO, 'data', 'audit');
const DRAIN_LEDGER_PATH = path.join(AUDIT_DIR, 'backlog-drain-ledger.jsonl');
const METRIC_PATH = path.join(AUDIT_DIR, 'backlog-drain-metric.json');
const VERIFIABILITY_REPORT_PATH = path.join(AUDIT_DIR, 'card-verifiability.json');

// Cap live `notion-brain get` calls per tick (rate-limit friendliness) —
// beyond this many unarmed/enrichment-needed candidates, stop scanning and
// report "none found this scan" rather than walking the whole backlog.
const MAX_CANDIDATE_SCAN = 20;

const USAGE = `backlog-drain.js — rate-limited whole-pool drain dispatcher (task #654).

Usage:
  node scripts/backlog-drain.js                       reconcile + maybe dispatch + write metric
  node scripts/backlog-drain.js --dry-run              preview selection, no dispatch/ledger/metric writes
  node scripts/backlog-drain.js --cap N                concurrency cap (default ${DEFAULT_CONCURRENCY_CAP})
  node scripts/backlog-drain.js --spend-threshold N    circuit-breaker $ threshold (default ${DEFAULT_SPEND_THRESHOLD_USD})
  --help, -h   show this message, do nothing else
`;

function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith('--')) {
      const k = t.slice(2);
      const n = argv[i + 1];
      if (n === undefined || n.startsWith('--')) a[k] = true;
      else { a[k] = n; i++; }
    } else a._.push(t);
  }
  return a;
}

function readLedger(p) {
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* skip corrupt line */ }
  }
  return out;
}

function appendLedger(p, entry) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function writeJsonAtomic(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(`${p}.tmp`, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(`${p}.tmp`, p);
}

function fetchCard(pageId) {
  try {
    const raw = execFileSync('node', [path.join(REPO, 'scripts', 'notion-brain.js'), 'get', pageId],
      { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(raw);
  } catch { return null; }
}

// Resolve prior 'drain-dispatch' ledger entries with no outcome yet into
// card-pass/card-fail, by cross-referencing dispatch-ledger.jsonl's shared
// job lifecycle (bsc-runner writes job-spawned/job-done/job-failed there,
// keyed by taskId) and the CURRENT shared-task-list status. "Pass" =
// bsc-runner's session finished cleanly (job-done) AND the task got marked
// completed since dispatch; anything else (job-failed/orphaned, or a
// job-done session that never actually completed the card) counts as a
// content failure — exactly the "burned money, card still not done" case
// attempt-memory exists to stop. A job with no terminal event yet is left
// unresolved for a later tick.
function reconcileOutcomes(drainLedgerEntries, tasksById, dispatchLedgerEntries) {
  const resolvedTaskIds = new Set(
    drainLedgerEntries.filter(e => e.event === 'card-pass' || e.event === 'card-fail').map(e => String(e.cardId)));
  const jobs = [...dispatchLedger.foldJobs(dispatchLedgerEntries).values()];
  const dispatches = drainLedgerEntries.filter(e => e.event === 'drain-dispatch');
  const newEntries = [];
  for (const d of dispatches) {
    const taskId = String(d.taskId);
    if (resolvedTaskIds.has(taskId)) continue;
    let latest = null;
    for (const job of jobs) {
      if (String(job.taskId) !== taskId) continue;
      if (!latest || new Date(job.ts) > new Date(latest.ts)) latest = job;
    }
    if (!latest || !dispatchLedger.TERMINAL_JOB_EVENTS.has(latest.event)) continue; // still running or not yet visible
    const task = tasksById.get(taskId);
    const completed = !!(task && task.status === 'completed');
    const sessionOk = latest.event === dispatchLedger.JOB_EVENTS.DONE;
    const outcome = (sessionOk && completed) ? 'card-pass' : 'card-fail';
    newEntries.push({
      event: outcome,
      cardId: taskId,
      contentHash: d.contentHash,
      usd: Number(latest.costUSD) || 0,
      note: outcome === 'card-pass'
        ? 'session finished, task marked completed'
        : (sessionOk ? 'session finished but task still not completed' : `job ${latest.event}${latest.stage ? `: ${latest.stage}` : ''}`),
    });
    resolvedTaskIds.add(taskId);
  }
  return newEntries;
}

async function main(argv = process.argv.slice(2)) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }
  const args = parseArgs(argv);
  const dryRun = !!args['dry-run'];
  const cap = args.cap ? parseInt(args.cap, 10) : DEFAULT_CONCURRENCY_CAP;
  const spendThreshold = args['spend-threshold'] ? parseFloat(args['spend-threshold']) : DEFAULT_SPEND_THRESHOLD_USD;

  const tasks = loadTasks(TASKS_DIR);
  if (!tasks.length) {
    console.error('[backlog-drain] shared task list is empty — nothing to drain.');
    return;
  }
  const tasksById = new Map(tasks.map(t => [String(t.id), t]));

  let drainLedgerEntries = readLedger(DRAIN_LEDGER_PATH);
  const dispatchLedgerEntries = dispatchLedger.readEntries();

  // 1. Reconcile.
  const newOutcomes = reconcileOutcomes(drainLedgerEntries, tasksById, dispatchLedgerEntries);
  for (const o of newOutcomes) {
    console.log(`[backlog-drain] reconciled #${o.cardId}: ${o.event} (${o.note})`);
    if (!dryRun) appendLedger(DRAIN_LEDGER_PATH, o);
  }
  drainLedgerEntries = dryRun ? drainLedgerEntries.concat(newOutcomes) : readLedger(DRAIN_LEDGER_PATH);

  // 2. Concurrency.
  const drainDispatchedTaskIds = new Set(
    drainLedgerEntries.filter(e => e.event === 'drain-dispatch').map(e => String(e.taskId)));
  const concurrency = computeConcurrency(drainDispatchedTaskIds, dispatchLedgerEntries, cap);

  // 3. Spend circuit breaker.
  const breaker = computeSpendCircuitBreaker(drainLedgerEntries, { thresholdUSD: spendThreshold });

  // 4. Verifiability report (awaiting-enrichment bucket + selection filter).
  const report = readJson(VERIFIABILITY_REPORT_PATH);
  const refusedNotionIds = new Set(((report && report.refused) || []).map(c => c.id));

  // 5. Parked map (attempt-memory).
  const pendingTasksAll = tasks.filter(t => t.status === 'pending');
  const parkedIds = computeParkedMap(pendingTasksAll, drainLedgerEntries);

  // 6. Metric — always computed, regardless of whether a dispatch happens.
  const priorMetric = readJson(METRIC_PATH);
  const metric = computeDrainMetric(tasks, {
    refusedNotionIds, notionIdOfFn: notionIdOf, parkedIds,
    priorHistory: (priorMetric && priorMetric.history) || [],
  });

  let dispatchedTask = null;
  let skipReason = null;

  if (concurrency.atCap) {
    skipReason = `at concurrency cap (${concurrency.alive}/${cap} drain jobs alive: ${concurrency.aliveTaskIds.join(', ')})`;
  } else if (breaker.halt) {
    skipReason = breaker.reason;
  } else {
    const order = candidateOrder(tasks, {
      parkedIds, refusedNotionIds, notionIdOfFn: notionIdOf,
      inFlightIds: new Set(concurrency.aliveTaskIds),
    });
    let scanned = 0;
    for (const t of order) {
      if (scanned >= MAX_CANDIDATE_SCAN) break;
      scanned++;
      const nid = notionIdOf(t);
      if (!nid) continue; // native task, no card to live-verify-gate — drain stays conservative
      const card = fetchCard(nid);
      if (!card || !card.notes) continue;
      const gate = evaluateVerifiability(card.notes);
      if (!gate.cmd) continue; // owner-judgment-only or genuinely unarmed — never unattended-dispatched
      dispatchedTask = t;
      break;
    }
    if (!dispatchedTask) {
      skipReason = order.length
        ? `scanned ${scanned} candidate(s), none had a machine-runnable verify command`
        : 'no eligible pending cards (all human/parked/in-flight/enrichment-flagged)';
    }
  }

  if (dispatchedTask) {
    if (dryRun) {
      console.log(`[backlog-drain] DRY RUN would dispatch #${dispatchedTask.id}: ${dispatchedTask.subject}`);
    } else {
      appendLedger(DRAIN_LEDGER_PATH, {
        event: 'drain-dispatch', taskId: String(dispatchedTask.id),
        subject: dispatchedTask.subject, contentHash: taskContentHash(dispatchedTask),
      });
      const child = spawn('node', [path.join(REPO, 'scripts', 'bsc-next.js'), '--id', String(dispatchedTask.id), '--headless'],
        { cwd: REPO, detached: true, stdio: 'ignore' });
      child.unref();
      console.log(`[backlog-drain] dispatched #${dispatchedTask.id}: ${dispatchedTask.subject} (headless, detached)`);
    }
  } else {
    console.log(`[backlog-drain] no dispatch this tick: ${skipReason}`);
  }

  const snapshot = {
    generatedAt: metric.generatedAt,
    bannerText: formatBannerText(metric),
    items: dispatchedTask
      ? [{ title: `Dispatched #${dispatchedTask.id}: ${String(dispatchedTask.subject).slice(0, 90)}` }]
      : [],
    moreCount: 0,
    pending: metric.pending,
    humanWaiting: metric.humanWaiting,
    parked: metric.parked,
    awaitingEnrichment: metric.awaitingEnrichment,
    netDrainWeek: metric.netDrainWeek,
    history: metric.history,
  };
  if (!dryRun) writeJsonAtomic(METRIC_PATH, snapshot);

  console.log(`[backlog-drain] ${formatBannerText(metric)}`);
  if (dryRun) console.log('[backlog-drain] --dry-run: no ledger/metric writes, no dispatch sent');
}

if (require.main === module) {
  main().catch(e => { console.error(`[backlog-drain] fatal: ${e.stack || e.message}`); process.exit(1); });
}

module.exports = {
  parseArgs, readLedger, appendLedger, readJson, writeJsonAtomic, fetchCard,
  reconcileOutcomes, main, USAGE,
  AUDIT_DIR, DRAIN_LEDGER_PATH, METRIC_PATH, VERIFIABILITY_REPORT_PATH, MAX_CANDIDATE_SCAN,
};
