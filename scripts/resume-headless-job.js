#!/usr/bin/env node
/**
 * resume-headless-job — continue a timed-out headless fix session (task #1184 S1).
 *
 * A 120-min job that hits its wall is SIGTERM'd with its session id, worktree,
 * and cost journaled on the dispatch-ledger job-failed entry (bsc-runner.js).
 * bsc-reconcile spawns THIS wrapper detached to continue that session — a
 * resume can run for another full job budget, so it must never run inline in
 * bsc-reconcile's 5-minute launchd tick (the tick would block for hours and
 * launchd skips overlapping runs, silently disabling orphan detection).
 *
 * All the real machinery lives in bsc-runner.runJob (lease, ledger lifecycle,
 * budget preamble, worktree keep/teardown) — this file is only argv parsing
 * plus one runJob call, the same thin-CLI-over-lib shape as backlog-drain.js.
 *
 * Usage: node scripts/resume-headless-job.js --task 123 --session <uuid> --cwd <path> [--model sonnet]
 */

'use strict';

const fs = require('fs');
const { runJob } = require('./lib/bsc-runner.js');

const RESUME_PROMPT =
  'Your previous headless run on this task hit its wall-clock budget and was terminated. '
  + 'Its work is committed (or sitting uncommitted) in this worktree — check `git status`, `git log`, and STATE.md if present. '
  + 'Continue exactly where it left off and finish the task, including the merge/verify/complete steps the original card requires.';

function argOf(argv, flag) {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] !== undefined ? argv[i + 1] : null;
}

async function main(argv = process.argv.slice(2)) {
  const taskId = argOf(argv, '--task');
  const sessionId = argOf(argv, '--session');
  const cwd = argOf(argv, '--cwd');
  const model = argOf(argv, '--model');
  if (!taskId || !sessionId || !cwd) {
    console.error('usage: resume-headless-job.js --task N --session <uuid> --cwd <path> [--model m]');
    process.exit(2);
  }
  if (!fs.existsSync(cwd)) {
    console.error(`[resume-headless-job] cwd gone (${cwd}) — nothing to resume into`);
    process.exit(1);
  }
  const r = await runJob({
    taskId, subject: `resume #${taskId}`, isolate: false, cwd,
    resumeSessionId: sessionId, prompt: RESUME_PROMPT, model: model || undefined,
    // A resumed Linear job answers to the LINEAR dispatcher's kill switch,
    // not bsc-next's — same per-dispatcher rule as the original spawn
    // (BRO-286): LINEAR_NEXT_DISABLED=1 must stop Linear resumes, and the
    // morning-digest plist's BSC_RUNNER_DISABLED=1 must not.
    killSwitchEnv: String(taskId).startsWith('linear:') ? 'LINEAR_NEXT_DISABLED' : 'BSC_RUNNER_DISABLED',
  });
  console.log(`[resume-headless-job] task #${taskId} resume ${r.ok ? 'DONE' : `FAILED (${r.stage})`} (job ${r.jobId}${r.logFile ? `, log ${r.logFile}` : ''})`);
  process.exit(r.ok ? 0 : 1);
}

if (require.main === module) {
  main().catch(e => { console.error(`[resume-headless-job] crashed: ${e.message}`); process.exit(1); });
}

module.exports = { main, RESUME_PROMPT };
