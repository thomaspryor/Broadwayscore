#!/usr/bin/env node
/**
 * archive-completed-tasks — one-time (rerunnable) prune of the shared task
 * store: moves tasks completed >48h ago out of ~/.claude/tasks/<list>/ into
 * a sibling archive/ subdirectory. Card #854: the live directory is
 * serialized into the harness's injected task-list reminder on every
 * TaskList-adjacent nudge (~860 lines observed 2026-08-02, avg 16x/session
 * per the 5-day audit) — archiving completed work is the direct lever.
 *
 * Safe to rerun: each run only touches tasks newly crossing the 48h mark.
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
const { selectArchivable, loadTasksWithMtime, archiveCompletedTasks } = require('./lib/task-store-archive.js');

const USAGE = `archive-completed-tasks — move tasks completed >48h ago to archive/.

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
    console.log(`[archive-completed-tasks] DRY RUN — dir=${dir}`);
    console.log(`  ${ids.length} of ${tasks.length} task(s) would archive: ${ids.join(', ') || '(none)'}`);
    return;
  }

  const { archived, skipped, bytesFreed } = archiveCompletedTasks(dir, { now: Date.now() });
  console.log(`[archive-completed-tasks] dir=${dir}`);
  console.log(`  archived: ${archived.length} (${bytesFreed} bytes freed from the live dir)`);
  if (skipped.length) {
    console.log(`  skipped: ${skipped.length}`);
    for (const s of skipped) console.log(`    #${s.id}: ${s.reason}`);
  }
}

if (require.main === module) main();

module.exports = { tasksDir };
