#!/usr/bin/env node
/**
 * predispatch-queue-audit — tally predispatch-guard verdicts (task #1801)
 * AND all 8 sibling dispatch-guards.js refusal predicates (task #1802)
 * across every pending/in_progress task in the local mirror, write the
 * digest snapshots scripts/send-morning-digest.js reads.
 *
 * Same card-fetch pattern as scripts/predispatch-check.js: resolve each
 * task's Notion id via notionIdOf() (the structured `[notion:<uuid>]` tag),
 * never search, then `notion-brain.js get <uuid>` and classifyCandidate().
 * Mac-local producer, same as scripts/backlog-drain.js — both this script
 * and send-morning-digest.js run on the same Mac via launchd
 * (com.broadwayscore.predispatch-queue-audit.plist, scheduled before the
 * 7:30am digest), so there's no cross-machine gap to bridge with a git
 * commit; the snapshot + history files are gitignored.
 *
 * Task #1802 (dispatch-guards.js's other 8 guards — deadDispatchGuard,
 * parkedGuard, staleOutcomeGuard, closedCardGuard, workBranchCollisionGuard,
 * exactTitleOverlapGuard, sessionTrackingCloneGuard, linearMirrorGuard) rides
 * in THIS SAME per-task loop rather than a second script with its own
 * launchd plist (second-opinion review, 2026-08-19): two independent `node`
 * processes cannot share fetchCard()'s in-memory result, so a second script
 * would double Notion API load (300-400 sequential execFileSync calls
 * instead of 150-200) in the same pre-digest window instead of "reusing"
 * anything. One fetch pass, two tallies, two snapshot files.
 *
 * Usage:
 *   node scripts/predispatch-queue-audit.js
 *   node scripts/predispatch-queue-audit.js --dry-run   classify, don't write
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');
const {
  notionIdOf, loadLinearMirrorMapping,
  deadDispatchGuard, parkedGuard, staleOutcomeGuard, closedCardGuard,
  workBranchCollisionGuard, exactTitleOverlapGuard, sessionTrackingCloneGuard,
  linearMirrorGuard, matchesTaskWorkBranch, findWorkBranchCollisions, GUARD_NAMES,
} = require('./lib/dispatch-guards.js');
const { classifyCandidate, resolveNotionUuid } = require('./lib/predispatch-guard.js');
const { buildQueueAuditSnapshot } = require('./lib/predispatch-queue-audit.js');
const { buildDispatchGuardQueueAuditSnapshot } = require('./lib/dispatch-guard-queue-audit.js');
const dispatchLedger = require('./lib/dispatch-ledger.js');
const { findOverlappingCards } = require('./lib/dispatch-overlap-check.js');
const { unlandedCommitsFor } = require('./lib/worktree-branch-guard.js');
const { mergeWithArchive } = require('./lib/task-store-archive.js');

const REPO = path.join(__dirname, '..');
const LIST_ID = process.env.CLAUDE_CODE_TASK_LIST_ID || 'broadwayscore';
const TASKS_DIR = path.join(os.homedir(), '.claude', 'tasks', LIST_ID);
const AUDIT_DIR = path.join(REPO, 'data', 'audit');
const SNAPSHOT_FILE = path.join(AUDIT_DIR, 'predispatch-queue-audit-snapshot.json');
const HISTORY_FILE = path.join(AUDIT_DIR, 'predispatch-queue-audit-history.json');
const GUARD_SNAPSHOT_FILE = path.join(AUDIT_DIR, 'dispatch-guard-queue-audit-snapshot.json');
const GUARD_HISTORY_FILE = path.join(AUDIT_DIR, 'dispatch-guard-queue-audit-history.json');
// ~3 weeks of daily entries — always leaves a usable 5-9 day-old comparator
// for findWeekAgoEntry even if a run or two is missed.
const HISTORY_MAX = 21;

const USAGE = `predispatch-queue-audit — tally predispatch-guard AND every sibling dispatch-guards.js verdict across every queued task, write the digest snapshots.

Usage:
  node scripts/predispatch-queue-audit.js            run + write snapshot/history
  node scripts/predispatch-queue-audit.js --dry-run   classify + print only, don't write
  node scripts/predispatch-queue-audit.js --help      show this message, do nothing else
`;

// A missing/unreadable TASKS_DIR (wrong CLAUDE_CODE_TASK_LIST_ID, wrong
// machine, launchd PATH/cwd misconfiguration) must fail loud, not degrade to
// an empty task list — an empty list produces the exact same "0 of 0 queued
// cards blocked" snapshot as a genuinely healthy quiet day, so a broken
// config would silently read as "all clear" forever (ship-check adversarial
// finding; same vacuous-gate class as #1063/#1069, see
// scripts/lib/dispatch-outcome-digest.js's identical guard).
function loadQueuedTasks() {
  const files = fs.readdirSync(TASKS_DIR).filter((f) => f.endsWith('.json'));
  const tasks = [];
  for (const f of files) {
    try {
      const t = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), 'utf8'));
      if (t && (t.status === 'pending' || t.status === 'in_progress')) tasks.push(t);
    } catch { /* skip unreadable/corrupt task mirror file — one bad file must not kill the audit */ }
  }
  return tasks;
}

// 30s timeout (ship-check adversarial finding): this loop runs one
// execFileSync per queued task (150-200+ sequential calls at 6:50am,
// before the 7:30am digest). Without a bound, a single hung
// `notion-brain.js get` call — a stalled Notion API request — wedges the
// whole launchd job indefinitely, leaving the snapshot un-refreshed for
// every downstream card too. execFileSync throws on timeout, which the
// caller already treats as a per-card fetch error (fetchErrors++), so one
// slow card degrades the count instead of hanging the run.
const NOTION_FETCH_TIMEOUT_MS = 30_000;

function fetchCard(uuid) {
  const out = execFileSync('node', [path.join(REPO, 'scripts', 'notion-brain.js'), 'get', uuid], {
    encoding: 'utf8', timeout: NOTION_FETCH_TIMEOUT_MS,
  });
  return JSON.parse(out);
}

function loadHistory(file = HISTORY_FILE) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

// git ops for workBranchCollisionGuard (task #1802), batched ONCE per run
// instead of once per task. Its real implementation
// (worktree-branch-guard.js's listWorkBranchStatuses) does a `git fetch` +
// `git branch --list` on every call, which is fine for a single live dispatch
// but unaffordable 150-200x in this loop. Fetch + list the full worktree-/job-
// branch namespace once, then only compute the expensive part
// (unlandedCommitsFor's merge-base/cherry subprocess pair) for branches that
// actually match one of THIS run's queued tasks — bounded by how many queued
// tasks have branches, not by the full namespace (500+ branches per
// worktree-branch-guard.js's own header).
function listAllWorkBranchNames(repoDir, defaultBranch) {
  try {
    execFileSync('git', ['fetch', 'origin', defaultBranch, '-q'], { cwd: repoDir, timeout: 20000 });
  } catch { /* offline/timeout — use whatever origin/<defaultBranch> already points at locally */ }
  try {
    const raw = execFileSync('git', ['branch', '--list', 'worktree-*', 'job/*', '--format=%(refname:short)'], { cwd: repoDir, encoding: 'utf8' });
    return raw.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (err) {
    // ship-check adversarial finding: a total `git branch --list` failure
    // (not offline — a real repo/permissions problem) used to degrade
    // silently to an empty branch list, which makes workBranchCollisionGuard
    // report 0 refused for every task — indistinguishable from a genuinely
    // quiet day. Logged so the launchd job's stderr log (not just the
    // digest banner) carries the signal.
    console.error(`[predispatch-queue-audit] git branch --list failed, workBranchCollisionGuard will report 0 collisions this run: ${String(err.message).slice(0, 160)}`);
    return [];
  }
}

function computeBranchStatuses(tasks, repoDir, defaultBranch = 'main') {
  let names;
  try { names = listAllWorkBranchNames(repoDir, defaultBranch); }
  catch { return []; }
  const matched = new Set();
  for (const name of names) {
    for (const t of tasks) {
      if (matchesTaskWorkBranch(name, t.id)) { matched.add(name); break; }
    }
  }
  return [...matched].map((name) => {
    try { return { name, unlandedCommits: unlandedCommitsFor(name, repoDir, defaultBranch) }; }
    catch { return { name, unlandedCommits: [] }; }
  });
}

// Runs one dispatch-guards.js predicate and normalizes its outcome to the
// {refusal: string|null} shape dispatch-guard-queue-audit.js's tally expects
// — or `null` (not the shape) when the guard function itself threw, so a
// crash can't silently read as "ok" (tallyGuardRefusals counts that as
// `error`, never folded into `ok`).
function runGuard(name, fn, taskId) {
  try {
    return { refusal: fn() || null };
  } catch (err) {
    console.error(`[predispatch-queue-audit] guard ${name} threw for #${taskId}: ${String(err.message).slice(0, 160)}`);
    return null;
  }
}

function main() {
  if (hasHelpFlag(process.argv.slice(2))) {
    process.stdout.write(USAGE);
    process.exit(0);
  }
  const dryRun = process.argv.includes('--dry-run');
  const now = Date.now();

  let tasks;
  try {
    tasks = loadQueuedTasks();
  } catch (err) {
    console.error(`[predispatch-queue-audit] task mirror unreadable at ${TASKS_DIR}: ${err.message}`);
    console.error('[predispatch-queue-audit] refusing to write a snapshot — a missing/unreadable task mirror would misreport a healthy "0 blocked" (vacuous-gate class, #1063/#1069)');
    process.exit(1);
  }

  // Shared, read-ONCE-per-run inputs for the 8 sibling guards (task #1802) —
  // none of these are per-task I/O. loadLinearMirrorMapping/mergeWithArchive
  // already fail open (empty mapping / plain `tasks`) on any read error, same
  // direction as every guard in dispatch-guards.js on missing data.
  const ledgerEntries = dispatchLedger.readEntries();
  const linearMapping = loadLinearMirrorMapping();
  let tasksWithArchive = tasks;
  try { tasksWithArchive = mergeWithArchive(TASKS_DIR, tasks); }
  catch (err) { console.error(`[predispatch-queue-audit] archive merge failed, using live tasks only: ${String(err.message).slice(0, 160)}`); }
  const inProgressCards = tasksWithArchive
    .filter((t) => t && t.status === 'in_progress')
    .map((t) => ({ id: t.id, subject: t.subject, notes: t.description }));
  const branchStatuses = computeBranchStatuses(tasks, REPO);

  const classifications = [];
  const guardResults = [];
  let skippedNoUuid = 0;
  let fetchErrors = 0;
  for (const task of tasks) {
    const uuid = notionIdOf(task) || resolveNotionUuid(task.description || '');
    // #1803: card fetch no longer short-circuits with `continue` on a
    // missing uuid/failed fetch — #1802's 6 non-card guards below still need
    // to evaluate every task. `id: task.id` on the pushed classification is
    // #1803's own addition (feeds predispatch-queue-audit.js's named
    // blocked-card items) — preserved here across the #1802 merge.
    let card = null;
    if (!uuid) {
      skippedNoUuid++;
    } else {
      try { card = fetchCard(uuid); }
      catch (err) { fetchErrors++; console.error(`[predispatch-queue-audit] fetch failed for #${task.id}: ${String(err.message).slice(0, 160)}`); }
    }
    if (card) {
      try { classifications.push({ ...classifyCandidate({ card, task }), id: task.id }); }
      catch (err) { fetchErrors++; console.error(`[predispatch-queue-audit] classify failed for #${task.id}: ${String(err.message).slice(0, 160)}`); }
    }

    // Task #1802: the other 8 dispatch-guards.js predicates. Run with
    // opts={} (no force/dry-run/print-prompt) so this reports REAL refusal
    // state, not a bypassed one. staleOutcomeGuard/closedCardGuard fail open
    // on card===null (Notion outage or no-uuid native task) exactly the way
    // a live bsc-next.js dispatch attempt would under the same conditions —
    // that is genuine "ok" data here, not an audit error.
    const own = { id: task.id, subject: task.subject, notes: task.description };
    const overlaps = findOverlappingCards(own, inProgressCards.filter((c) => String(c.id) !== String(task.id)));
    // GUARD_NAMES (dispatch-guards.js) is the canonical list every 8 keys
    // below must match — this object is NOT built by looping over
    // GUARD_NAMES because each guard needs a different extra argument
    // (ledgerEntries/card/branchStatuses/overlaps/tasksWithArchive/mapping).
    // Adding a 9th guard to GUARD_NAMES means adding a matching runGuard()
    // call here too, or tallyGuardRefusals will report it as 100% "error"
    // forever (see dispatch-guard-queue-audit.test.mjs's GUARD_NAMES test).
    guardResults.push({
      taskId: task.id,
      guards: {
        deadDispatchGuard: runGuard('deadDispatchGuard', () => deadDispatchGuard(task, ledgerEntries, {}), task.id),
        parkedGuard: runGuard('parkedGuard', () => parkedGuard(task, ledgerEntries, {}), task.id),
        staleOutcomeGuard: runGuard('staleOutcomeGuard', () => staleOutcomeGuard(task, card, {}), task.id),
        closedCardGuard: runGuard('closedCardGuard', () => closedCardGuard(task, card, {}), task.id),
        workBranchCollisionGuard: runGuard('workBranchCollisionGuard', () => workBranchCollisionGuard(task, branchStatuses, {}), task.id),
        exactTitleOverlapGuard: runGuard('exactTitleOverlapGuard', () => exactTitleOverlapGuard(task, overlaps, {}), task.id),
        sessionTrackingCloneGuard: runGuard('sessionTrackingCloneGuard', () => sessionTrackingCloneGuard(task, tasksWithArchive, {}), task.id),
        linearMirrorGuard: runGuard('linearMirrorGuard', () => linearMirrorGuard(task, linearMapping, {}), task.id),
      },
    });
  }

  const history = loadHistory(HISTORY_FILE);
  const snapshot = buildQueueAuditSnapshot({ classifications, history, now, skippedNoUuid, fetchErrors });
  console.log(`predispatch-queue-audit: ${snapshot.bannerText}`);

  const guardHistory = loadHistory(GUARD_HISTORY_FILE);
  const guardSnapshot = buildDispatchGuardQueueAuditSnapshot({ results: guardResults, history: guardHistory, now });
  console.log(`dispatch-guard-queue-audit: ${guardSnapshot.bannerText}`);

  if (dryRun) return;

  fs.mkdirSync(AUDIT_DIR, { recursive: true });
  writeFileAtomic(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2) + '\n');
  const newHistory = [...history, { at: snapshot.generatedAt, blockedCount: snapshot.blockedCount }].slice(-HISTORY_MAX);
  writeFileAtomic(HISTORY_FILE, JSON.stringify(newHistory, null, 2) + '\n');

  writeFileAtomic(GUARD_SNAPSHOT_FILE, JSON.stringify(guardSnapshot, null, 2) + '\n');
  const newGuardHistory = [...guardHistory, { at: guardSnapshot.generatedAt, blockedCount: guardSnapshot.blockedCount }].slice(-HISTORY_MAX);
  writeFileAtomic(GUARD_HISTORY_FILE, JSON.stringify(newGuardHistory, null, 2) + '\n');
}

// write-then-rename (ship-check adversarial finding): send-morning-digest.js
// (via digest-snapshots.js's readSnapshot) reads this same file. A plain
// writeFileSync is not atomic — a reader that opens the file mid-write would
// see a truncated/partial JSON parse failure. rename(2) on the same
// filesystem is atomic, so a concurrent reader always sees either the old
// complete file or the new complete file, never a torn one.
function writeFileAtomic(filePath, contents) {
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, filePath);
}

if (require.main === module) main();

module.exports = {
  loadQueuedTasks, fetchCard, loadHistory, TASKS_DIR, SNAPSHOT_FILE, HISTORY_FILE,
  GUARD_SNAPSHOT_FILE, GUARD_HISTORY_FILE, computeBranchStatuses, listAllWorkBranchNames, runGuard,
};
