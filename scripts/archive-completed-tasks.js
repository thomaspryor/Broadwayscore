#!/usr/bin/env node
/**
 * archive-completed-tasks — rerunnable prune of the shared task store: moves
 * tasks completed >24h ago, in_progress tasks untouched >7d (orphans — the
 * dispatching session died without ever flipping status), pending tasks
 * untouched >30d, and "BSC Daily:"-titled pending tasks untouched >7d, out
 * of ~/.claude/tasks/<list>/ into a sibling archive/ subdirectory. Card #854:
 * the live directory is serialized into the harness's injected task-list
 * reminder on every TaskList-adjacent nudge (~860 lines observed 2026-08-02,
 * avg 16x/session per the 5-day audit) — archiving is the direct lever.
 * Card #955 tightened the completed threshold (48h -> 24h) and added the
 * in_progress-orphan population — this script had never been scheduled
 * anywhere (no cron/launchd), so it only ever ran once (S1); see
 * com.broadwayscore.task-store-archive.plist for the daily schedule now
 * wired for it. Card #1351 added the pending and BSC-Daily populations —
 * pending tasks previously never aged out at all (389 open cards, 0
 * archivable, on 2026-08-12).
 *
 * Safe to rerun: each run only touches tasks newly crossing a threshold.
 * See scripts/lib/task-store-archive.js for the id-collision safety
 * rationale (never touches the top `keepTopN` ids present, regardless of
 * age/status).
 *
 *   node scripts/archive-completed-tasks.js             archive now
 *   node scripts/archive-completed-tasks.js --dry-run    show what would move
 *   node scripts/archive-completed-tasks.js --help, -h   show this message
 */

const os = require('os');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const {
  selectArchivable, loadTasksWithMtime, archiveCompletedTasks, BSC_DAILY_TITLE_RE,
} = require('./lib/task-store-archive.js');

const USAGE = `archive-completed-tasks — move tasks completed >24h ago, in_progress >7d untouched, pending >30d untouched, or 'BSC Daily:' pending >7d untouched, to archive/.

The in_progress population is archived with its copy RELABELLED to pending (and
owner cleared): an archived record must never keep claiming work is underway,
because nothing reachable ever flips it back. See scripts/lib/task-store-archive.js.

Usage:
  node scripts/archive-completed-tasks.js             archive now
  node scripts/archive-completed-tasks.js --dry-run    show what would move, move nothing
  node scripts/archive-completed-tasks.js --help, -h   show this message, do nothing else
`;

function tasksDir() {
  const listId = process.env.CLAUDE_CODE_TASK_LIST_ID || 'broadwayscore';
  return process.env.CLAUDE_CODE_TASKS_DIR || path.join(os.homedir(), '.claude', 'tasks', listId);
}

function main() {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const dryRun = process.argv.includes('--dry-run');
  const dir = tasksDir();

  if (dryRun) {
    const tasks = loadTasksWithMtime(dir);
    const ids = selectArchivable(tasks, { now: Date.now() });
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const isBscDaily = (t) => typeof t?.subject === 'string' && BSC_DAILY_TITLE_RE.test(t.subject);
    const completedCount = ids.filter((id) => byId.get(id)?.status === 'completed').length;
    const bscDailyCount = ids.filter((id) => byId.get(id)?.status === 'pending' && isBscDaily(byId.get(id))).length;
    const stalePendingCount = ids.length - completedCount - bscDailyCount - ids.filter((id) => byId.get(id)?.status === 'in_progress').length;
    const inProgressCount = ids.filter((id) => byId.get(id)?.status === 'in_progress').length;
    console.log(`[archive-completed-tasks] DRY RUN — dir=${dir}`);
    console.log(`  ${ids.length} of ${tasks.length} task(s) would archive (${completedCount} completed, ${stalePendingCount} stale pending, ${bscDailyCount} stale BSC Daily): ${ids.join(', ') || '(none)'}`);
    console.log(`  of those, ${inProgressCount} are stale in_progress — archived with the copy RELABELLED to pending (deadlock fix; the live file is never rewritten, only removed)`);
    return;
  }

  const { archived, relabelled, skipped, bytesFreed } = archiveCompletedTasks(dir, { now: Date.now() });
  console.log(`[archive-completed-tasks] dir=${dir}`);
  console.log(`  archived: ${archived.length} (${bytesFreed} bytes freed from the live dir)`);
  console.log(`  relabelled in the archive (in_progress -> pending): ${relabelled.length}${relabelled.length ? ` (${relabelled.join(', ')})` : ''}`);
  if (skipped.length) {
    console.log(`  skipped: ${skipped.length}`);
    for (const s of skipped) console.log(`    #${s.id}: ${s.reason}`);
  }
}

if (require.main === module) main();

module.exports = { tasksDir };
