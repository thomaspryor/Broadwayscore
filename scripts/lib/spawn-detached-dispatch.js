'use strict';
/**
 * spawn-detached-dispatch.js — re-exec a dispatcher CLI in its own session so
 * NOTHING on the caller's side can signal the job.
 *
 * WHY THIS EXISTS (BRO-3053, root-caused 2026-09-08). `linear-next.js
 * --headless` and `bsc-next.js --headless` AWAIT runJob() for the job's entire
 * life, so that node process is the parent of the whole job tree. A caller
 * that wraps the dispatch in a wall-clock guard —
 *
 *     timeout 110 node scripts/linear-next.js --id BRO-N --headless 2>&1 | tail -8
 *
 * — SIGTERMs the SUPERVISOR. Node's default SIGTERM disposition exits
 * immediately, so claude-cli.js's `child.on('close')` handler never runs: no
 * `===== <ts> exit=N =====` marker in the job log, and no terminal ledger row
 * from bsc-runner. The job dies invisibly mid-thought. Worse, `timeout`
 * without --foreground/-k signals only its direct child, so the claude
 * GRANDCHILD survives unsupervised and keeps writing to the job worktree —
 * which is BRO-3052's orphan hazard.
 *
 * Six jobs died this way on 2026-09-08 (predicted SIGTERM time matched the
 * last log write to the second, 6/6), and the `| tail` swallowed timeout's
 * rc=124 into exit 0 so the caller's task footer read "[exited with code 0]".
 * Five sessions then misdiagnosed it as memory starvation.
 *
 * FIXING THE SIGNAL HANDLING IN THE SUPERVISOR WAS THE WRONG ANSWER and was
 * reviewed out: resolving a promise and calling process.exit() in the same
 * handler are mutually exclusive, the `settled`/clearTimeout bookkeeping in
 * claude-cli.js is closure-local, and installing a SIGHUP handler would
 * override an inherited SIG_IGN in the five dispatchers that ALREADY spawn
 * detached. Detaching is the fix that makes the whole class impossible.
 *
 * This is the pattern already copy-pasted at bsc-prune.js:741, bsc-reconcile.js:188,
 * backlog-drain.js:588, digest-autofix.js:418 and dispatch-watchdog.js:245,
 * extracted so there is one copy to reason about. Those five sites are
 * deliberately NOT rewired here — they work, and converging them is its own
 * change with its own blast radius (tracked separately).
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

/**
 * Strip a boolean switch from an argv array, tolerating `--flag`, `--flag=1`
 * and `--flag=false`. Pure — exported for the test.
 *
 * The `=` form matters: linear-next.js's coerceFlagValue treats `--detach=0`
 * as OFF, so a re-exec that left the token in place would loop forever on the
 * `--detach=1` spelling and, worse, silently re-detach on every hop.
 *
 * @param {string[]} argv
 * @param {string} flag  bare name, no leading dashes (e.g. 'detach')
 * @returns {string[]}
 */
function stripFlag(argv, flag) {
  const bare = `--${flag}`;
  const withValue = `${bare}=`;
  return argv.filter(a => a !== bare && !a.startsWith(withValue));
}

/**
 * Re-exec `scriptPath` with `argv` in a NEW session (detached), stdio wired to
 * `logFile`, and unref'd so the caller can exit immediately.
 *
 * Returns { pid, logFile }. Throws only if spawn itself throws synchronously;
 * an async spawn error is reported on stderr by the attached error handler,
 * matching bsc-prune.js:742's shape.
 *
 * @param {object} o
 * @param {string} o.scriptPath  absolute path to the dispatcher to re-exec
 * @param {string[]} o.argv      argv for it (already stripped of --detach)
 * @param {string} o.logFile     absolute path; parent dirs created if needed
 * @param {string} [o.label]     used only in the spawn-error message
 * @param {function} [o.spawnFn] test seam
 * @param {function} [o.onError] test seam for the async spawn-error report
 */
function spawnDetachedDispatch({
  scriptPath,
  argv,
  logFile,
  label = 'dispatch',
  spawnFn = spawn,
  onError = (m) => console.error(m),
}) {
  if (!scriptPath || !logFile) throw new Error('spawnDetachedDispatch: scriptPath and logFile are required');
  let out = 'ignore';
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    out = fs.openSync(logFile, 'a');
  } catch { /* log loss must never block the dispatch — same as bsc-prune.js:741 */ }
  const child = spawnFn(process.execPath, [scriptPath, ...(argv || [])], {
    detached: true,
    stdio: ['ignore', out, out],
  });
  if (child && typeof child.on === 'function') {
    child.on('error', (e) => onError(`[${label}] detached spawn error: ${e.message} — nothing was dispatched.`));
  }
  if (child && typeof child.unref === 'function') child.unref();
  // The child holds its own dup'd fd; closing ours keeps this process from
  // pinning the file (bsc-prune.js:744 does the same).
  if (out !== 'ignore') { try { fs.closeSync(out); } catch { /* child owns its fd */ } }
  return { pid: child && child.pid, logFile };
}

module.exports = { spawnDetachedDispatch, stripFlag };
