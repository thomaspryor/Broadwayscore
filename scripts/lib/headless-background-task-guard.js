'use strict';

/**
 * headless-background-task-guard — BRO-2741.
 *
 * A headless `claude -p` job that ends its turn while a background task is
 * still live has that task killed at teardown, yet exits 0 and emits a normal
 * result envelope (job linear:BRO-2718-mtk78sto: ~13 of 200 items processed,
 * kill row end_time == the job-done ledger row, reported KEEP OPEN).
 *
 * Failing a job on "a kill row exists" was tried and reverted (eca80447ea4):
 * 65 of 155 real logs carried one and 64 were healthy, because the dominant
 * killed command is scripts/lib/wait-for-run.sh, the repo's own CI-wait
 * idiom. So this module only RECORDS the fact; it never changes an outcome.
 * Text-declared pending work ("Keep this tab open") is already routed to
 * job-stopped-short by headless-result-classifier.js. What was missing is that
 * the ledger row carried no trace of the kill, so a job-done hiding one read as
 * clean success everywhere downstream.
 *
 * Only tasks killed AFTER the result event count (teardown kills). A kill
 * before the result is the worker's own cleanup/TaskStop, not abandonment.
 */

const MAX_TASKS = 10;
const MAX_DESC = 80;
// Advisory only: the CI/land waits that dominate healthy teardown kills.
// Descriptions are raw command lines; never persist an inline credential.
const SECRET_RE = /\b[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Za-z0-9_]*=\S+/gi;
const WAIT_RE = /wait-for-run|\bwait(ing)?\b|\bpoll(ing)?\b|\bwatch\b|land\.yml|land\.js|merge-worktree-to-main/i;

function summarizeKilledTasks(killedTasks) {
  if (!Array.isArray(killedTasks)) return [];
  return killedTasks.slice(0, MAX_TASKS).map((t) => {
    const raw = t && typeof t.description === 'string' ? t.description : '';
    const description = raw ? raw.replace(SECRET_RE, '[redacted]').replace(/\s+/g, ' ').trim().slice(0, MAX_DESC) : null;
    return {
      id: (t && t.id) || 'unknown',
      description,
      backgrounded: Boolean(t && t.backgrounded),
      wait: description ? WAIT_RE.test(description) : false,
    };
  });
}

// Ledger-row fragment: `{}` when nothing was killed, so row shape is unchanged
// for every healthy job.
function killedTasksLedgerFields(killedTasks) {
  const s = summarizeKilledTasks(killedTasks);
  return s.length ? { killedBackgroundTasks: s, killedBackgroundTaskCount: killedTasks.length } : {};
}

module.exports = { summarizeKilledTasks, killedTasksLedgerFields, MAX_TASKS, MAX_DESC };
