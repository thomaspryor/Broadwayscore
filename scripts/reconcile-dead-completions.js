#!/usr/bin/env node
/**
 * reconcile-dead-completions — defense-in-depth for card #1144: find tasks
 * in the shared task list that are marked 'completed' even though their
 * most recent bsc-next/bsc-runner dispatch attempt is journaled dead (never
 * actually ran), and reopen them.
 *
 * The primary fix is a PreToolUse hook on TaskUpdate (~/.claude/hooks) that
 * refuses the bad write before it lands. This script exists for what still
 * slips past that hook: a cloud session with no ~/.claude/hooks (CLAUDE.md:
 * "Cloud sessions ... have no ~/.claude/"), a long-running session that
 * started before the hook was registered, or an explicit --force override.
 * Both consult the SAME decision function (scripts/lib/dispatch-dead-launch-
 * guard.js's reconcileDeadCompletions) — a task can't pass one check and
 * fail the other for the same underlying state.
 *
 *   node scripts/reconcile-dead-completions.js             report only
 *   node scripts/reconcile-dead-completions.js --fix        reopen matches
 *   node scripts/reconcile-dead-completions.js --help, -h   show this message
 */

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { loadTasks, TASKS_DIR } = require('./bsc-next.js');
const { readEntries } = require('./lib/dispatch-ledger.js');
const { reconcileDeadCompletions } = require('./lib/dispatch-dead-launch-guard.js');

const USAGE = `reconcile-dead-completions — reopen tasks marked 'completed' whose latest dispatch never ran.

Usage:
  node scripts/reconcile-dead-completions.js             report only, reopen nothing
  node scripts/reconcile-dead-completions.js --fix        reopen matches (status -> pending)
  node scripts/reconcile-dead-completions.js --help, -h   show this message
`;

// Ship-check adversarial finding: a bare prepend re-run of --fix (e.g. a
// scheduled job firing twice before the reopened task is re-dispatched)
// would stack duplicate banners onto `description` forever. The marker
// prefix makes the reopen idempotent — a task already carrying it is left
// untouched on a repeat run.
const REOPEN_MARKER = '[reconcile-dead-completions ';

function reopenTask(id, dir = TASKS_DIR) {
  const file = path.join(dir, `${id}.json`);
  const task = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (String(task.description || '').startsWith(REOPEN_MARKER)) return; // already reopened, no-op
  const note = `${REOPEN_MARKER}${new Date().toISOString().slice(0, 10)}] `
    + `reopened — marked completed while its most recent dispatch was journaled dead in dispatch-ledger.jsonl (card #1144).\n\n`;
  task.status = 'pending';
  task.owner = null;
  task.description = note + (task.description || '');
  fs.writeFileSync(file, JSON.stringify(task, null, 2));
}

function main(argv = process.argv.slice(2)) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }
  const fix = argv.includes('--fix');

  const tasks = loadTasks(TASKS_DIR);
  // readEntries() already fails open (returns [] on any read error) — no
  // try/catch needed here; it can't throw.
  const entries = readEntries();

  const flagged = reconcileDeadCompletions(tasks, entries);
  if (!flagged.length) {
    console.log('[reconcile-dead-completions] no false completions found.');
    return;
  }

  console.log(`${fix ? 'Reopening' : '[dry-run] would reopen'} ${flagged.length} task(s) completed while their dispatch was dead:`);
  for (const t of flagged) {
    console.log(`  #${t.id}  ${t.subject || '(no subject)'}`);
    if (fix) {
      try { reopenTask(t.id); }
      catch (e) { console.error(`    WARN reopen failed for #${t.id}: ${e.message}`); }
    }
  }
  if (!fix) console.log('\nRe-run with --fix to reopen these.');
}

if (require.main === module) main();

module.exports = { main, USAGE, reopenTask };
