#!/usr/bin/env node
/**
 * predispatch-queue-audit — tally predispatch-guard verdicts (task #1801)
 * AND all 9 sibling dispatch-guards.js refusal predicates (task #1802)
 * across every pending/in_progress task in the local mirror, write the
 * digest snapshots scripts/send-morning-digest.js reads.
 *
 * The predispatch tally (task #1801) is Linear-sourced only since BRO-5845:
 * the per-task Notion card fetch (a `get` against the retired Notion
 * board CLI) was removed, so the frozen local mirror now feeds only the
 * dispatch-guard tally below (card === null, which every card guard already
 * treats as fail-open).
 * Mac-local producer, same as scripts/backlog-drain.js — both this script
 * and send-morning-digest.js run on the same Mac via launchd
 * (com.broadwayscore.predispatch-queue-audit.plist, scheduled before the
 * 7:30am digest), so there's no cross-machine gap to bridge with a git
 * commit; the snapshot + history files are gitignored.
 *
 * Task #1802 (dispatch-guards.js's sibling guards: deadDispatchGuard,
 * parkedGuard, staleOutcomeGuard, closedCardGuard, workBranchCollisionGuard,
 * exactTitleOverlapGuard, sessionTrackingCloneGuard, linearMirrorGuard,
 * and BRO-2626's pathVerifiabilityGuard) rides
 * in THIS SAME per-task loop rather than a second script with its own
 * launchd plist (second-opinion review, 2026-08-19): two independent `node`
 * processes cannot share fetchCard()'s in-memory result, so a second script
 * would double Notion API load (300-400 sequential execFileSync calls
 * instead of 150-200) in the same pre-digest window instead of "reusing"
 * anything. (The Notion fetch itself was removed in BRO-5845.)
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
  loadLinearMirrorMapping,
  matchesTaskWorkBranch, findWorkBranchCollisions,
} = require('./lib/dispatch-guards.js');
const { buildQueueAuditSnapshot, buildSourceUnavailableSnapshot } = require('./lib/predispatch-queue-audit.js');
const { buildDispatchGuardQueueAuditSnapshot, simulateDispatchGuards } = require('./lib/dispatch-guard-queue-audit.js');
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
// BRO-5845: history rows tagged with the population they counted.
const HISTORY_SOURCE = 'linear';

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
    // unbounded-fetch-ok: this only ever runs from a live launchd cron job on
    // a full local Mac checkout (com.broadwayscore.predispatch-queue-audit.plist),
    // never from a CI shallow-checkout workflow — same justification as
    // worktree-branch-guard.js's identical `git fetch origin <default> -q`
    // call (listWorkBranchStatuses), which this function's batching is
    // modeled on.
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

async function main() {
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

  // Shared, read-ONCE-per-run inputs for the 9 sibling guards (task #1802) —
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

  const guardResults = [];
  for (const task of tasks) {
    // BRO-5845: no Notion card fetch any more; card is always null here.
    const card = null;

    // Task #1802: the 9 dispatch-guards.js predicates. Run with
    // opts={} (no force/dry-run/print-prompt) so this reports REAL refusal
    // state, not a bypassed one. staleOutcomeGuard/closedCardGuard fail open
    // on card===null (Notion outage or no-uuid native task) exactly the way
    // a live bsc-next.js dispatch attempt would under the same conditions —
    // that is genuine "ok" data here, not an audit error.
    const own = { id: task.id, subject: task.subject, notes: task.description };
    const overlaps = findOverlappingCards(own, inProgressCards.filter((c) => String(c.id) !== String(task.id)));
    guardResults.push(simulateDispatchGuards(task, {
      ledgerEntries, card, branchStatuses, overlaps, tasksWithArchive, linearMapping, repoRoot: REPO,
    }));
  }

  // BRO-3431: the local task mirror above is the FROZEN Notion board (source
  // of the "135 queued cards" undercount — the real backlog lives in Linear).
  // BRO-5845: Linear is now the ONLY source of predispatch classifications;
  // Never throw. A Linear outage publishes a "Linear unavailable" snapshot
  // and no history row (ship-check P1): an empty tally would read as a fresh
  // "0 of 0 blocked" in the morning digest, indistinguishable from a quiet day.
  let linearClassifications = [];
  let linearOk = false;
  let linearError = null;
  try {
    const { fetchLinearBacklogClassifications } = require('./lib/linear-predispatch-audit.js');
    const linearClient = require('./lib/linear-client.js');
    const res = await fetchLinearBacklogClassifications(linearClient, {});
    if (res.ok) {
      linearOk = true;
      linearClassifications = res.classifications;
      console.log(`[predispatch-queue-audit] Linear scan: ${res.scanned} issue(s) scanned, ${linearClassifications.length} counted toward the backlog tally`);
    } else {
      linearError = String(res.reason);
      console.error(`[predispatch-queue-audit] Linear source unavailable (${res.reason}) — publishing an unavailable snapshot`);
    }
  } catch (err) {
    linearError = String(err.message).slice(0, 160);
    console.error(`[predispatch-queue-audit] Linear source error (${linearError}) — publishing an unavailable snapshot`);
  }

  // Rows written before BRO-5845 counted the Notion mirror plus Linear; a
  // week-over-week jump against them compares two different populations.
  const history = loadHistory(HISTORY_FILE).filter((h) => h && h.source === HISTORY_SOURCE);
  const snapshot = linearOk
    ? buildQueueAuditSnapshot({ classifications: linearClassifications, history, now })
    : buildSourceUnavailableSnapshot({ reason: linearError, now });
  console.log(`predispatch-queue-audit: ${snapshot.bannerText}`);

  const guardHistory = loadHistory(GUARD_HISTORY_FILE);
  const guardSnapshot = buildDispatchGuardQueueAuditSnapshot({ results: guardResults, history: guardHistory, now });
  console.log(`dispatch-guard-queue-audit: ${guardSnapshot.bannerText}`);

  if (dryRun) return;

  fs.mkdirSync(AUDIT_DIR, { recursive: true });
  writeFileAtomic(SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2) + '\n');
  if (linearOk) {
    const newHistory = [...history, { at: snapshot.generatedAt, blockedCount: snapshot.blockedCount, source: HISTORY_SOURCE }].slice(-HISTORY_MAX);
    writeFileAtomic(HISTORY_FILE, JSON.stringify(newHistory, null, 2) + '\n');
  }

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

if (require.main === module) {
  main().catch((err) => {
    console.error(`[predispatch-queue-audit] FATAL: ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  });
}

module.exports = {
  loadQueuedTasks, loadHistory, TASKS_DIR, SNAPSHOT_FILE, HISTORY_FILE,
  GUARD_SNAPSHOT_FILE, GUARD_HISTORY_FILE, computeBranchStatuses, listAllWorkBranchNames,
};
