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
const { spawnSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { TASKS_DIR } = require('./bsc-next.js');
// loadTasksWithMtime (not bsc-next.js's loadTasks) — attachCompletedAtEstimates
// below needs each task's live-file mtime (card #1770/task #1701 incident).
// Already tested (task-store-archive.test.mjs) and already scoped to the LIVE
// TASKS_DIR only (never archive/, whose move rewrites mtime — see that file's
// header on attachCompletedAtEstimates).
const { loadTasksWithMtime } = require('./lib/task-store-archive.js');
const { readEntries } = require('./lib/dispatch-ledger.js');
const { reconcileDeadCompletions, shouldCorrectNotionStatus, attachCompletedAtEstimates } = require('./lib/dispatch-dead-launch-guard.js');

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

// Card #1157: reopenTask() only fixes the LOCAL task-store copy. The
// mirrored Notion card can have already been pushed to "Done" by
// notion-tasks-sync.js's push command (markCardDone) before the dead
// dispatch was discovered — real incident 2026-08-09, 4 cards found stuck
// on Done after their tasks were reopened. Mirrors bsc-prune.js's
// parkCard(): spawnSync notion-brain.js non-fatally from the CLI wrapper,
// never from the pure lib. Ledger/local reopen above is authoritative and
// already happened by the time this runs — a failure here is logged and
// paged, never re-thrown, and never un-reopens the local task.
function correctNotionCard(notionId, taskId) {
  const brain = path.join(__dirname, 'notion-brain.js');
  const getRes = spawnSync('node', [brain, 'get', notionId], { encoding: 'utf8', timeout: 60_000 });
  if (getRes.status !== 0) {
    throw new Error(`card lookup failed: ${(getRes.stderr || getRes.stdout || '').trim().split('\n').slice(-1)[0]}`);
  }
  let card;
  try { card = JSON.parse(getRes.stdout); }
  catch { throw new Error('card lookup returned unparseable JSON'); }
  // Read-then-check, not an unconditional write: a card the owner has since
  // re-triaged by hand (e.g. to "In progress") must not be clobbered back to
  // "Not started" just because its task was independently reopened.
  if (!card || !shouldCorrectNotionStatus(card.status)) return false;

  const today = new Date().toISOString().slice(0, 10);
  const updRes = spawnSync('node', [brain, 'update', notionId,
    '--status', 'Not started',
    '--outcome', `Auto-corrected ${today} by reconcile-dead-completions: task #${taskId} was marked completed while its dispatch was journaled dead (card #1144/#1157) — this card had been incorrectly pushed to Done.`,
  ], { encoding: 'utf8', timeout: 60_000 });
  if (updRes.status !== 0) {
    throw new Error(`card update failed: ${(updRes.stderr || updRes.stdout || '').trim().split('\n').slice(-1)[0]}`);
  }
  return true;
}

// A failed correction leaves a "Done" card that will never be retried by
// this script (once reopenTask flips the task to 'pending' it permanently
// drops out of reconcileDeadCompletions's 'completed' filter) — the exact
// silent-drift this card exists to fix. A launchd log nobody tails doesn't
// close that gap, so a failure is also paged to the digest (best-effort;
// never blocks or masks the console.error already printed).
function pageNotionCorrectionFailure(taskId, notionId, err) {
  try {
    const { routeAlert } = require('./lib/owner-alert-router.js');
    routeAlert({
      conditionKey: `reconcile-dead-completions:notion-correction-failed:${taskId}`,
      title: `Reopened task #${taskId} but its Notion card is still "Done"`,
      description: `reconcile-dead-completions reopened task #${taskId} locally (dead-dispatch completion) but could not correct its mirrored Notion card ${notionId} back off "Done": ${err.message}. Fix by hand: node scripts/notion-brain.js update ${notionId} --status "Not started".`,
      severity: 'warning',
      disposition: 'digest',
      cooldownHours: 24,
    }).catch(() => {});
  } catch { /* alerting must never mask the reopen that already succeeded */ }
}

function main(argv = process.argv.slice(2)) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }
  const fix = argv.includes('--fix');

  const tasks = attachCompletedAtEstimates(loadTasksWithMtime(TASKS_DIR));
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
    console.log(`  #${t.id}  ${t.subject || '(no subject)'}${t.notionId ? `  [notion:${t.notionId}]` : ''}`);
    if (fix) {
      try { reopenTask(t.id); }
      catch (e) { console.error(`    WARN reopen failed for #${t.id}: ${e.message}`); }
      if (t.notionId) {
        try {
          const corrected = correctNotionCard(t.notionId, t.id);
          if (corrected) console.log(`    corrected Notion card ${t.notionId} status Done -> Not started`);
        } catch (e) {
          console.error(`    WARN Notion correction failed for #${t.id} (card ${t.notionId}): ${e.message}`);
          pageNotionCorrectionFailure(t.id, t.notionId, e);
        }
      }
    }
  }
  if (!fix) console.log('\nRe-run with --fix to reopen these.');
}

if (require.main === module) main();

module.exports = { main, USAGE, reopenTask, correctNotionCard };
