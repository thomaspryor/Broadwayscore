#!/usr/bin/env node
/**
 * audit-archived-in-progress.js — report the tasks trapped by the archiver
 * deadlock, split by whether they ever actually started.
 *
 * WHY THIS EXISTS. task-store-archive.js used to move an `in_progress` task
 * into archive/ after 7 days untouched while its status still said
 * in_progress. The only thing that would ever flip it back to pending is
 * sweepUntrackedInProgress (bsc-reconcile.js), which reads the LIVE dir only
 * (bscNext.loadTasks is live-dir-only by deliberate design — see the card #854
 * docstring at bsc-next.js:84-95). So those tasks became PERMANENTLY
 * in_progress: unreachable by the sweep, invisible to --list/actionable(),
 * dispatchable only by explicit --id. Measured 2026-08-12: 86 of 146.
 *
 * The forward leak is fixed (the archiver now reclaims to pending instead of
 * archiving), but that fix cannot see the ones already inside archive/ — by
 * construction, nothing reads that directory during selection. This script is
 * the read-only half of the recovery: it says exactly what is in there and
 * splits it into the two populations that need DIFFERENT handling.
 *
 * THE SPLIT MATTERS. A trapped task with zero dispatch-ledger entries never
 * actually started — it is un-started work wearing a finished-work label, and
 * returning it to the pool loses nothing. A trapped task WITH ledger entries
 * did start, so there may be real commits on a job branch; restoring it blind
 * could re-run work that already exists. Of 15 sampled by hand on 2026-08-12,
 * 14 were the former and 1 the latter.
 *
 * Read-only by design: it mutates nothing and takes no --fix. Restoring 86
 * tasks to the visible pool changes what every session's --list shows and what
 * the backlog drain can pick, against a measured intake of 34.3 cards/day vs
 * 5.7 burn-down. That is an owner call, not a side effect of an audit.
 *
 * Usage:
 *   node scripts/audit-archived-in-progress.js            summary + the split
 *   node scripts/audit-archived-in-progress.js --list     every trapped task
 *   node scripts/audit-archived-in-progress.js --json      machine-readable
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help');

const USAGE = `audit-archived-in-progress.js — report tasks trapped in archive/ while still in_progress.

Usage:
  node scripts/audit-archived-in-progress.js [--list] [--json]

  --list  print every trapped task (default prints the summary + top 15)
  --json  emit JSON instead of prose

Read-only. Mutates nothing — restoring these to the visible pool is an owner
decision (see this file's header for why).
`;

const DAY_MS = 24 * 60 * 60 * 1000;

function tasksDir() {
  const listId = process.env.CLAUDE_CODE_TASK_LIST_ID || 'broadwayscore';
  return process.env.CLAUDE_CODE_TASKS_DIR || path.join(os.homedir(), '.claude', 'tasks', listId);
}

/**
 * Pure: which archived tasks are trapped, and did each ever start?
 * Extracted per CLAUDE.md §15 so the test exercises the real predicate.
 *
 * @param {Array<{id, status, subject, mtimeMs}>} archivedTasks
 * @param {Set<string>} dispatchedIds - task ids present in the dispatch ledger
 * @param {number} now
 */
function classifyTrapped(archivedTasks, dispatchedIds, now) {
  const trapped = (archivedTasks || [])
    .filter((t) => t && t.status === 'in_progress')
    .map((t) => ({
      id: String(t.id),
      subject: t.subject || '(no subject)',
      ageDays: typeof t.mtimeMs === 'number' ? Math.floor((now - t.mtimeMs) / DAY_MS) : null,
      everDispatched: dispatchedIds.has(String(t.id)),
    }))
    .sort((a, b) => (b.ageDays ?? -1) - (a.ageDays ?? -1));
  return {
    trapped,
    neverStarted: trapped.filter((t) => !t.everDispatched),
    startedAndLost: trapped.filter((t) => t.everDispatched),
  };
}

function readArchivedWithMtime(dir) {
  const archiveDir = path.join(dir, 'archive');
  let files;
  try { files = fs.readdirSync(archiveDir); } catch { return []; }
  const out = [];
  for (const f of files.filter((n) => /^\d+\.json$/.test(n))) {
    const p = path.join(archiveDir, f);
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      out.push({ ...parsed, id: String(parsed.id ?? f.replace('.json', '')), mtimeMs: fs.statSync(p).mtimeMs });
    } catch { /* unparseable archive entry — not this audit's problem */ }
  }
  return out;
}

// Events that mean "this task actually got launched". The ledger also carries
// purely operational rows keyed by taskId — `prune`, `prune-closed`, `vanished`,
// `remapped`, `stall-sweep-attempted` — and 2,351 of its rows are `prune`
// alone. Counting those as evidence of a start would mark a never-started task
// as "started then lost" and route it into the wrong recovery bucket (Codex
// review, 2026-08-12). Keep this list to events emitted by a dispatcher at or
// after launch.
const START_EVENTS = new Set([
  'launch', 'launch-failed', 'job-spawned', 'job-done', 'job-failed',
  'job-orphaned', 'job-retried', 'watchdog-resurrect', 'watchdog-redispatch',
]);

/**
 * Task ids the dispatch ledger shows a real launch attempt for.
 *
 * Returns `null` — NOT an empty Set — when the ledger is unreadable. That
 * distinction is load-bearing: `data/audit/dispatch-ledger.jsonl` is gitignored
 * (.gitignore:312), so it does not exist in a git worktree at all. An empty Set
 * makes every task look never-started, and this audit reported exactly that
 * wrong answer ("86 never started, 0 started-then-lost") when first run from a
 * worktree; the real split from the main checkout is 59/27. Same failure shape
 * as the health digest going green in CI because its ledgers were missing —
 * absent input must read as "cannot answer", never as "answer is zero".
 */
function dispatchedTaskIds(repoRoot) {
  const ids = new Set();
  const p = path.join(repoRoot, 'data', 'audit', 'dispatch-ledger.jsonl');
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch { return null; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      // String() both sides: ledger taskIds are strings ("1355"), task-store
      // ids can be numeric, and === across those types would classify every
      // started task as never-started.
      if (e && e.taskId != null && START_EVENTS.has(e.event)) ids.add(String(e.taskId));
    } catch { /* skip malformed line */ }
  }
  return ids;
}

function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }
  const dir = tasksDir();
  const repoRoot = path.join(__dirname, '..');
  const archived = readArchivedWithMtime(dir);
  const dispatched = dispatchedTaskIds(repoRoot);
  if (dispatched === null) {
    // Refuse rather than mislead. The never-started/started split is the whole
    // point of this audit and it is unanswerable without the ledger.
    const msg = `dispatch-ledger.jsonl not readable at ${path.join(repoRoot, 'data', 'audit', 'dispatch-ledger.jsonl')}\n`
      + '  It is gitignored, so it does not exist in a git worktree. Re-run from the main checkout\n'
      + '  (/Users/tompryor/Broadwayscore). Refusing to classify: with no ledger every task would\n'
      + '  look never-started, which is a wrong answer, not a cautious one.';
    if (argv.includes('--json')) console.log(JSON.stringify({ error: msg }, null, 2));
    else console.error(`[audit-archived-in-progress] REFUSED — ${msg}`);
    process.exitCode = 2;
    return;
  }
  const { trapped, neverStarted, startedAndLost } = classifyTrapped(archived, dispatched, Date.now());

  if (argv.includes('--json')) {
    console.log(JSON.stringify({ dir, archivedTotal: archived.length, trapped, neverStarted: neverStarted.length, startedAndLost: startedAndLost.length }, null, 2));
    return;
  }

  console.log(`[audit-archived-in-progress] dir=${dir}`);
  console.log(`  ${archived.length} archived task(s); ${trapped.length} still say in_progress and are therefore unreachable`);
  if (!trapped.length) { console.log('  nothing trapped — the deadlock population is drained.'); return; }
  console.log(`    never started (0 dispatch-ledger rows): ${neverStarted.length} — safe to return to the pool, no work exists to lose`);
  console.log(`    started then lost (has ledger rows):     ${startedAndLost.length} — check for commits on a job branch BEFORE re-running`);
  const ages = trapped.map((t) => t.ageDays).filter((n) => typeof n === 'number').sort((a, b) => a - b);
  if (ages.length) {
    console.log(`  age in archive: median ${ages[Math.floor(ages.length / 2)]}d, oldest ${ages[ages.length - 1]}d`);
  }
  const show = argv.includes('--list') ? trapped : trapped.slice(0, 15);
  console.log(`  ${argv.includes('--list') ? 'all' : 'oldest 15'}:`);
  for (const t of show) {
    console.log(`    #${t.id} ${t.ageDays != null ? `${t.ageDays}d` : '?'} ${t.everDispatched ? '[STARTED]' : '[never started]'} ${t.subject.slice(0, 74)}`);
  }
  if (!argv.includes('--list') && trapped.length > 15) console.log(`    ... +${trapped.length - 15} more (--list for all)`);
}

if (require.main === module) main();

module.exports = { classifyTrapped, readArchivedWithMtime, dispatchedTaskIds, tasksDir, START_EVENTS };
