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
const { gitSafeJobId } = require('./lib/bsc-runner.js'); // job branches use the SANITIZED id (linear: ids carry a git-illegal colon)

const REPO = '/Users/tompryor/Broadwayscore';
const LIST_ID = process.env.CLAUDE_CODE_TASK_LIST_ID || 'broadwayscore';
const TASKS_DIR = path.join(os.homedir(), '.claude', 'tasks', LIST_ID);

const { loadTasks, notionIdOf } = require('./bsc-next.js');
const dispatchLedger = require('./lib/dispatch-ledger.js');
const dispatchReconcile = require('./lib/dispatch-reconcile.js');
const { evaluateVerifiability } = require('./lib/verify-gate.js');
const { classifyHeadlessDispatchability } = require('./lib/headless-dispatchability.js');
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
const LOG_DIR = path.join(AUDIT_DIR, 'backlog-drain-logs');

// Cap live `notion-brain get` calls per tick (rate-limit friendliness) —
// beyond this many unarmed/enrichment-needed candidates, stop scanning and
// report "none found this scan" rather than walking the whole backlog.
//
// Task #1184 S3: this cap used to bound CANDIDATES CONSIDERED, not fetches —
// human-gated and unarmed cards each consumed a slot, and candidateOrder is
// oldest-id-first, so 8 permanently human-gated rage-click cards at the head
// of the queue starved the drain to ZERO dispatches from 8/5 to 8/9 while
// ~200 dispatchable cards sat behind them. The cap now bounds live card
// FETCHES (the thing that actually costs Notion quota); known-undispatchable
// verdicts are cached below and skipped without a fetch or a slot.
const MAX_CANDIDATE_SCAN = 60;

// Cached "this card can't run unattended" verdicts (human-gated or unarmed),
// so the same 8 cards stop being re-fetched and re-classified every tick.
// TTL-based re-arm, NOT permanent (plan-review design P1: a bare persisted
// ID set has no invalidation — a card edited to become dispatchable would
// stay skipped forever; attempt-memory re-arms on content change, but card
// notes aren't visible without the very fetch this cache avoids, so a 24h
// re-evaluation bound is the invalidation). Cached skips still ride
// humanGatedSkips into the metric/digest — cached must never mean invisible.
const HUMAN_GATED_CACHE_PATH = path.join(AUDIT_DIR, 'drain-human-gated-cache.json');
const HUMAN_GATED_CACHE_TTL_MS = 24 * 3600 * 1000;
// Kill switch (rollout guard): legacy pre-#1184 window semantics.
const WINDOW_FIX_DISABLED = process.env.DRAIN_WINDOW_FIX_DISABLED === '1';

function loadSkipCache(p = HUMAN_GATED_CACHE_PATH) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) || {}; } catch { return {}; }
}

function saveSkipCache(cache, p = HUMAN_GATED_CACHE_PATH) {
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(cache, null, 2));
  } catch { /* cache is an optimization — losing it just costs re-fetches */ }
}

function skipCacheFresh(entry, nowMs, ttlMs = HUMAN_GATED_CACHE_TTL_MS) {
  if (!entry || !Number.isFinite(Date.parse(entry.ts))) return false;
  const ageMs = nowMs - Date.parse(entry.ts);
  // A future-dated ts (clock skew, corrupted write) must not read as fresh
  // forever — allow 60s of skew, nothing more (ship-check QA finding).
  return ageMs >= -60_000 && ageMs < ttlMs;
}

// How long to wait for a dispatched detached child to reach bsc-runner's
// job-spawned event before giving up on it (ship-check adversarial finding):
// the detached `bsc-next.js --headless` spawn can be refused before ever
// reaching bsc-runner (runner disabled, live cmux duplicate) with no
// terminal ledger event at all — without a timeout, that drain-dispatch
// entry would sit unresolved forever, permanently occupying a concurrency
// slot and never reaching attempt-memory. 3h is generous: even the largest
// (M) envelope's wall-clock cap is 120min; this only fires for a spawn that
// never even started.
const ORPHAN_TIMEOUT_H = 3;

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

// Find the job THIS drain-dispatch actually caused (ship-check adversarial
// finding): dispatch-ledger.foldJobs's "last event wins" merge overwrites a
// job's `ts` field with its TERMINAL event's timestamp, so "the job with the
// latest ts for this taskId" can silently match a job a manual `bsc-next
// --headless` run started well after (or even before, on a stale read) this
// drain-dispatch — crediting a drain pass/fail to someone else's dispatch.
// Instead, scan the RAW ledger for job-SPAWNED events on this taskId at or
// after the drain-dispatch's own timestamp (5s buffer for clock skew), take
// the EARLIEST such spawn (the one this dispatch's child process caused),
// then fold only that jobId's entries to read its current state.
//
// Task #1184 S1 (ship-check Codex finding): a timed-out drain job the
// reconciler resumed ends 'job-retried'; without following the chain the
// resumed successor's real outcome was ignored and the dispatch scored
// card-fail into attempt-memory while the resume was still working. The
// shared implementation follows that chain — see dispatch-reconcile.findMyJob
// and dispatch-ledger.followRetryChain.
//
// Re-exported (not re-implemented) since BRO-2542: this file, digest-autofix.js
// and linear-drain-parked.js each had a byte-for-byte copy of it.
const findMyJob = dispatchReconcile.findMyJob;

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
//
// If NO job-spawned event ever appears within ORPHAN_TIMEOUT_H (ship-check
// adversarial finding): the detached bsc-next.js --headless spawn can be
// refused before it ever reaches bsc-runner (runner disabled, live cmux
// duplicate) — that refusal happens silently inside the detached child
// (see main()'s log-file redirect below), and without this timeout the
// drain-dispatch entry would sit unresolved forever, permanently occupying
// a concurrency slot while the digest keeps showing "Dispatched #N" for
// work that never actually started.
// Commits sitting on a finished job's branch that never reached origin/main.
// A non-zero count is the difference between "this session produced nothing"
// and "this session produced verified work the landing gate refused" — the
// distinction the 2026-08-04 drain postmortem got wrong (task #1004).
// Excludes anything reachable from EITHER origin/main or local main (ship-check
// finding): the local origin/main ref goes stale between fetches, and a session
// that merged its branch into local main but hasn't pushed yet would otherwise
// be reported as stranded work that is in fact already landed.
function countStrandedCommits(jobId) {
  if (!jobId) return 0;
  try {
    const out = execFileSync('git', ['-C', REPO, 'rev-list', '--count', `job/${gitSafeJobId(jobId)}`, '--not', 'origin/main', 'main'],
      { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
    return parseInt(String(out).trim(), 10) || 0;
  } catch {
    return 0; // branch already deleted/merged, or git unavailable — not stranded
  }
}

// Did THIS job's own branch land? The tip of job/<jobId> being an ancestor of
// origin/main (or local main, which countStrandedCommits already treats as
// equally authoritative) is proof the drain's own session produced the work —
// as opposed to the card merely being `completed` in the shared task mirror,
// which ANY writer can do: a human clicking Done in Notion, notion-tasks-sync's
// pull, or a parallel Cmux session that picked the same card up.
// That distinction is the whole point (plan-review 2026-08-05, unanimous across
// Codex/Gemini/pre-mortem/structure/design): crediting an unattributed
// completion as card-pass would feed spendCircuitBreakerStatus a completion it
// did not earn, and since that breaker only halts while completions === 0, ONE
// false pass suppresses every real card-fail in the same 24h window — i.e. it
// silently disables the only cost guard the drain has.
// Fails CLOSED: a missing/deleted branch, or git being unavailable, is "not
// attributable", never "attributed".
// Branch-ancestor is the STRONG signal, but it evaporates: worktree-gc deletes
// merged job branches, so a card whose work landed days ago has no branch left.
// Verified on the real #68: its work IS on main (6042f5ae27a "repair dead
// Wikipedia synopsis matcher") but job/68-msf7br29 no longer exists, so the
// ancestor check alone scored the exact case this fix exists for as
// unattributed. Hence the second, weaker path below.
function jobBranchLanded(jobId) {
  if (!jobId) return false;
  for (const ref of ['origin/main', 'main']) {
    try {
      execFileSync('git', ['-C', REPO, 'merge-base', '--is-ancestor', `job/${gitSafeJobId(jobId)}`, ref],
        { stdio: ['ignore', 'ignore', 'ignore'] });
      return true;
    } catch { /* not an ancestor of this ref — try the next */ }
  }
  return false;
}

// WEAKER fallback: a commit referencing this task landed on main DURING the
// job's own lifetime. Commit bodies carry "(task #N)" by repo convention and
// survive branch deletion. Deliberately windowed to [spawn, terminal] rather
// than "since dispatch" — the wider window would credit the drain for an
// interactive session that happened to work the same card, which is precisely
// the over-crediting the plan-review flagged as able to suppress the spend
// breaker. Callers record WHICH signal fired so a strict metric can ignore this
// one; it is evidence, not proof.
// TWO TRAPS, both verified empirically — do not "clean up" without re-testing:
// 1. The \b below relies on git's DEFAULT basic-regex mode honouring GNU's
//    word-boundary extension. Adding --extended-regexp/-E SILENTLY BREAKS IT
//    (produces zero matches), which would turn every late-landing card into
//    completion-unattributed. Verified on Apple Git 2.50.1: "task #7" correctly
//    does NOT match a "task #70" commit as written.
// 2. Deliberately origin/main only, unlike jobBranchLanded/countStrandedCommits
//    which also consult local main. An unpushed-but-merged commit is therefore
//    missed — undercounting, never over-crediting. That asymmetry is the safe
//    direction for a signal that gates the spend breaker.
function taskCommitLandedInWindow(taskId, fromTs, toTs) {
  if (!taskId || !fromTs) return false;
  try {
    const out = execFileSync('git', ['-C', REPO, 'log', 'origin/main', '--since', new Date(fromTs).toISOString(),
      ...(toTs ? ['--until', new Date(toTs).toISOString()] : []),
      '--format=%s%n%b', '--regexp-ignore-case', '--grep', `task #${taskId}\\b`],
      { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' });
    return String(out).trim().length > 0;
  } catch {
    return false;
  }
}

// A dispatch is resolved by an outcome recorded AT OR AFTER it, not by "this
// card has an outcome somewhere in history" (ship-check finding, Codex
// 2026-08-04). The old card-id Set meant a card dispatched a SECOND time — after
// the owner edited it, or after a park cleared — never produced another
// card-pass/card-fail/card-stranded at all: no spend accounting, no attempt
// memory, no retry ceiling. That was already true for card-fail before this
// change; card-stranded would have inherited it.
// completion-unattributed resolves a dispatch too: the card IS done, so
// re-dispatching it would burn money on finished work. It is deliberately not a
// pass — see jobBranchLanded above for why that separation matters.
const RESOLVING_EVENTS = new Set(['card-pass', 'card-fail', 'card-stranded', 'completion-unattributed']);
// Arity-3 wrapper binding this module's own outcome vocabulary. The shared
// implementation takes the event set as a 4th argument (see
// dispatch-reconcile.isDispatchResolved) because backlog-drain's vocabulary is
// richer than its two siblings'; keeping the 3-arg shape here is what lets
// callers and tests go on using it unchanged.
function isDispatchResolved(drainLedgerEntries, taskId, dispatchTs) {
  return dispatchReconcile.isDispatchResolved(drainLedgerEntries, taskId, dispatchTs, RESOLVING_EVENTS);
}

function reconcileOutcomes(drainLedgerEntries, tasksById, dispatchLedgerEntries, now = new Date(), opts = {}) {
  const strandedCommitsFn = opts.strandedCommits || countStrandedCommits;
  const landedFn = opts.jobBranchLanded || jobBranchLanded;
  const commitRefFn = opts.taskCommitLandedInWindow || taskCommitLandedInWindow;
  // Correlation, resolution and the same-pass jobId race guard all live in
  // scripts/lib/dispatch-reconcile.js since BRO-2542 — including the
  // Number.isFinite(ts) filter and the "check only the IMMUTABLE pre-pass
  // entries" rule, whose postmortems are in that file's header. What stays
  // here is only what is genuinely this drain's own: its four-outcome
  // vocabulary, its spend accounting, and the stranded/attribution logic below.
  const decisions = dispatchReconcile.classifyDispatches({
    ledgerEntries: drainLedgerEntries,
    dispatchLedgerEntries,
    isDispatchRow: e => e.event === 'drain-dispatch',
    resolvingEvents: RESOLVING_EVENTS,
    orphanTimeoutH: ORPHAN_TIMEOUT_H,
    cardIdOf: d => String(d.taskId),
    taskIdOf: d => String(d.taskId),
    now,
  });
  const newEntries = [];
  for (const { dispatch: d, cardId: taskId, job, kind } of decisions) {
    if (kind === 'orphan') {
      newEntries.push({
        event: 'card-fail', cardId: taskId, contentHash: d.contentHash, usd: 0,
        note: `spawn never observed within ${ORPHAN_TIMEOUT_H}h of dispatch (likely refused: runner disabled, live cmux duplicate, or lease already held)`,
      });
      continue;
    }
    if (kind === 'retry-timeout') {
      // The retry chain ended at 'job-retried' and no successor spawned inside
      // the orphan bound: the resume child died before spawning, and the
      // attempt scores as a fail.
      newEntries.push({
        event: 'card-fail', cardId: taskId, contentHash: d.contentHash, usd: Number(job.costUSD) || 0,
        note: `resume recorded (job ${job.jobId}) but no successor session spawned within ${ORPHAN_TIMEOUT_H}h`,
      });
      continue;
    }
    const task = tasksById.get(taskId);
    const completed = !!(task && task.status === 'completed');
    const sessionOk = job.event === dispatchLedger.JOB_EVENTS.DONE;
    // card-stranded (task #1004): the session finished cleanly and left real
    // commits on its job branch, but the card never closed — the work exists
    // and only the landing gate stopped it. Scoring that as card-fail is what
    // produced the "0-for-4, $14.74, zero completions" reading on 2026-08-04
    // when two of the four sessions had in fact produced finished, verified
    // work. It is deliberately NEITHER a pass (nothing landed, so the spend
    // breaker still halts) NOR a plain fail. It DOES still feed attempt-memory
    // as a failed attempt (see computeParkedMap in lib/backlog-drain.js): a card
    // that strands twice on unchanged content is burning money without landing
    // and must park, whatever the reason.
    // Stranded inspection must NOT be gated on sessionOk: a job that timed out
    // can still have left real commits on its branch, and suppressing the check
    // for exactly that case is what let a timed-out-but-productive session be
    // scored a plain failure (task #68, 2026-08-05).
    const stranded = !completed ? strandedCommitsFn(job.jobId) : 0;
    // Attribution, not just completion. `completed` alone is the shared mirror's
    // status, writable by anyone (see jobBranchLanded). A pass requires either
    // the drain's own job exiting cleanly, or — for the timed-out case — proof
    // that this job's own branch actually landed.
    let attribution = null;
    if (completed && !sessionOk) {
      if (landedFn(job.jobId)) attribution = 'branch-ancestor';
      // Window = drain-dispatch ts -> job's terminal ts. NOT job.spawnedTs:
      // foldJobs never sets such a field (grep: zero producers), so referencing it
      // would be dead code masquerading as a real per-job spawn time. d.ts precedes
      // the actual spawn by seconds — the same slack findMyJob's 5s buffer allows.
      else if (commitRefFn(taskId, d.ts, job.ts)) attribution = 'commit-ref';
    }
    const landedLate = attribution !== null;
    let outcome;
    if (completed && (sessionOk || landedLate)) outcome = 'card-pass';
    else if (completed) outcome = 'completion-unattributed';
    else if (stranded > 0) outcome = 'card-stranded';
    else outcome = 'card-fail';
    const notes = {
      'card-pass': landedLate
        ? `job ${job.event} (timed out) but its work landed on main via ${attribution} — the drain's own work completed late`
        : 'session finished, task marked completed',
      'completion-unattributed': `card is completed but job/${job.jobId} never landed and the job did not finish (${job.event}) — closed by another writer, NOT credited to the drain`,
      'card-stranded': `session finished with ${stranded} unmerged commit(s) on job/${job.jobId} but the card never closed — verified work blocked at the landing gate, not lost`,
      'card-fail': sessionOk ? 'session finished but task still not completed' : `job ${job.event}${job.stage ? `: ${job.stage}` : ''}`,
    };
    newEntries.push({
      event: outcome,
      cardId: taskId,
      contentHash: d.contentHash,
      usd: Number(job.costUSD) || 0,
      note: notes[outcome],
      strandedCommits: stranded || undefined,
      strandedBranch: stranded ? `job/${job.jobId}` : undefined,
      attribution: attribution || undefined,
    });
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
  const humanGatedSkips = [];

  if (concurrency.atCap) {
    skipReason = `at concurrency cap (${concurrency.alive}/${cap} drain jobs alive: ${concurrency.aliveTaskIds.join(', ')})`;
  } else if (breaker.halt) {
    skipReason = breaker.reason;
  } else {
    const order = candidateOrder(tasks, {
      parkedIds, refusedNotionIds, notionIdOfFn: notionIdOf,
      inFlightIds: new Set(concurrency.aliveTaskIds),
    });
    const nowMs = Date.now();
    const skipCache = WINDOW_FIX_DISABLED ? {} : loadSkipCache();
    let cacheDirty = false;
    let fetches = 0;
    let fetchErrors = 0;
    let cachedSkips = 0;
    for (const t of order) {
      if (fetches >= MAX_CANDIDATE_SCAN) break;
      const id = String(t.id);
      const nid = notionIdOf(t);
      if (!nid) continue; // native task, no card to live-verify-gate — drain stays conservative
      // Fresh cached undispatchable verdict: skip WITHOUT a fetch and WITHOUT
      // consuming the window — this is the entire #1184 S3 fix. Still surfaced
      // in the metric so the skip never goes invisible.
      const cached = skipCache[id];
      if (!WINDOW_FIX_DISABLED && skipCacheFresh(cached, nowMs)) {
        cachedSkips++;
        humanGatedSkips.push({ id, codes: cached.codes || ['CACHED'], cached: true });
        continue;
      }
      fetches++;
      const card = fetchCard(nid);
      if (!card) {
        // Fetch failure is NOT "unarmed" (Codex plan-review finding): a Notion
        // rate-limit blip must not park a dispatchable card for 24h. Count it,
        // report it, never cache it.
        fetchErrors++;
        continue;
      }
      if (!card.notes) {
        // NOT cached (ship-check finding): a transient/partial Notion response
        // with empty notes is indistinguishable from a real notes-less card,
        // and caching it would suppress a dispatchable card for 24h. It just
        // consumes a fetch slot and gets re-read next tick.
        continue;
      }
      const gate = evaluateVerifiability(card.notes);
      if (!gate.cmd) {
        // owner-judgment-only or genuinely unarmed — never unattended-dispatched
        if (!WINDOW_FIX_DISABLED) { skipCache[id] = { ts: new Date(nowMs).toISOString(), codes: ['UNARMED'] }; cacheDirty = true; }
        continue;
      }
      // Task #1004: armed is not the same as finishable. A card whose PUSH
      // needs the owner's visual-qa affirmative, or whose completion waits on
      // a cron/workflow that outlives the session, burns a full session and
      // still scores card-fail. Skip it here rather than pay for it.
      const hg = classifyHeadlessDispatchability(
        { subject: t.subject, notes: card.notes }, { verifyCmd: gate.cmd });
      if (!hg.dispatchable) {
        // Recorded, not just logged (ship-check finding): a wrongly-refused card
        // would otherwise be skipped silently on every tick forever, with the
        // only trace in a launchd log nobody reads. These ids ride the metric
        // snapshot into the daily digest, so a bad classification is visible and
        // the owner can dispatch it to a tab (or run bsc-next
        // --headless --allow-human-gated) instead of it just vanishing.
        humanGatedSkips.push({ id, codes: hg.blockers.map(b => b.code) });
        console.log(`[backlog-drain] skipping #${t.id} (needs a human to finish): ${hg.reason}`);
        if (!WINDOW_FIX_DISABLED) { skipCache[id] = { ts: new Date(nowMs).toISOString(), codes: hg.blockers.map(b => b.code) }; cacheDirty = true; }
        continue;
      }
      dispatchedTask = t;
      break;
    }
    if (cacheDirty && !dryRun) saveSkipCache(skipCache);
    if (!dispatchedTask) {
      const gatedNote = humanGatedSkips.length ? `, ${humanGatedSkips.length} needed a human to finish (${cachedSkips} from cache)` : '';
      const fetchNote = fetchErrors ? `, ${fetchErrors} card fetch(es) FAILED (rate limit? not cached, retried next tick)` : '';
      skipReason = order.length
        ? `fetched ${fetches} card(s), none dispatchable unattended${gatedNote}${fetchNote}`
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
      // stdio 'ignore' (ship-check adversarial finding) swallowed the exact
      // signal that explains a refusal (runner disabled, live cmux
      // duplicate, lease-held) — capture to a log file instead so a refused
      // dispatch is debuggable, not silent. Closing our own fd right after
      // spawn is safe: the detached child holds its own duplicated fd.
      fs.mkdirSync(LOG_DIR, { recursive: true });
      const logPath = path.join(LOG_DIR, `${dispatchedTask.id}-${Date.now()}.log`);
      const logFd = fs.openSync(logPath, 'a');
      const child = spawn('node', [path.join(REPO, 'scripts', 'bsc-next.js'), '--id', String(dispatchedTask.id), '--headless'],
        { cwd: REPO, detached: true, stdio: ['ignore', logFd, logFd] });
      child.unref();
      fs.closeSync(logFd);
      // "dispatch attempted", not "dispatched" (ship-check adversarial
      // finding): this log line fires the instant spawn() is called, before
      // bsc-next's own verify-gate/duplicate/dead-dispatch guards have run —
      // reconcileOutcomes (via the job-spawned correlation above) is the
      // actual proof a dispatch succeeded, not this line.
      console.log(`[backlog-drain] dispatch attempted for #${dispatchedTask.id}: ${dispatchedTask.subject} (headless, detached; log: ${logPath})`);
    }
  } else {
    console.log(`[backlog-drain] no dispatch this tick: ${skipReason}`);
  }

  const snapshot = {
    generatedAt: metric.generatedAt,
    bannerText: formatBannerText(metric),
    items: dispatchedTask
      ? [{ title: `Dispatch attempted for #${dispatchedTask.id}: ${String(dispatchedTask.subject).slice(0, 90)}` }]
      : [],
    moreCount: 0,
    pending: metric.pending,
    humanWaiting: metric.humanWaiting,
    parked: metric.parked,
    awaitingEnrichment: metric.awaitingEnrichment,
    humanGatedSkips,
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
  findMyJob, reconcileOutcomes, main, USAGE, jobBranchLanded, taskCommitLandedInWindow, RESOLVING_EVENTS,
  AUDIT_DIR, DRAIN_LEDGER_PATH, METRIC_PATH, VERIFIABILITY_REPORT_PATH, LOG_DIR,
  MAX_CANDIDATE_SCAN, ORPHAN_TIMEOUT_H,
  loadSkipCache, saveSkipCache, skipCacheFresh, HUMAN_GATED_CACHE_PATH, HUMAN_GATED_CACHE_TTL_MS,
};
