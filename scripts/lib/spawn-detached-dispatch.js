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
 *
 * RELATIONSHIP TO digest-autofix.js's dispatchDetached(). That helper does the
 * same OS-level thing and is more hardened for its job (id-shape validation,
 * a `sleep N &&` stagger so parallel spawns do not race the main repo's
 * `git worktree add` lock, an --allow-autofix-filed opt-in). It is NOT reused
 * here because it builds its own fixed argument list from a taskId — it can
 * emit `--id X --headless [--model M] [--allow-autofix-filed]` and nothing
 * else. `--detach` has to forward whatever the operator actually typed
 * (--force, --allow-human-gated, --allow-unverifiable, --allow-reported-work,
 * --model, ...), so it needs an argv-forwarding primitive, which is what this
 * is. Programmatic callers that construct a dispatch should keep using
 * dispatchDetached; this exists for the CLI's own re-exec.
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
 * @param {string} [o.cwd]       working directory for the child; pass the
 *                               CANONICAL repo root, never a worktree —
 *                               bsc-reconcile.js:188, backlog-drain.js:588 and
 *                               digest-autofix.js:418 all set cwd: REPO for
 *                               the same reason (the dispatcher and its ledger
 *                               must be the one canonical copy).
 * @param {string} [o.label]     used only in the spawn-error message
 * @param {function} [o.spawnFn] test seam
 * @param {function} [o.onError] test seam for the async spawn-error report
 */
function spawnDetachedDispatch({
  scriptPath,
  argv,
  logFile,
  cwd,
  label = 'dispatch',
  spawnFn = spawn,
  onError = (m) => console.error(m),
}) {
  if (!scriptPath || !logFile) throw new Error('spawnDetachedDispatch: scriptPath and logFile are required');
  let out = 'ignore';
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    out = fs.openSync(logFile, 'a');
  } catch (e) {
    // Log loss must never BLOCK the dispatch (same as bsc-prune.js:741) — but
    // it must not be silent either. Falling through to stdio 'ignore' without
    // saying so is how a refusal becomes invisible, which is the exact class
    // this module exists to close (ship-check finding).
    onError(`[${label}] WARNING: could not open ${logFile} (${e.message}) — dispatching with NO log. Any refusal from the child will be invisible.`);
  }
  const child = spawnFn(process.execPath, [scriptPath, ...(argv || [])], {
    detached: true,
    stdio: ['ignore', out, out],
    ...(cwd ? { cwd } : {}),
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

/**
 * Watch a detached child from OUTSIDE for `windowMs`, reporting whether it is
 * still alive at the end.
 *
 * WHY THIS IS NEEDED. Detaching before any validation means the launcher
 * validates nothing: every loud refusal the dispatcher exists to give
 * (unknown issue, parked sentinel, human gate, verify gate, kill switch,
 * terminal state, lease already held) would move into a log file nobody is
 * watching — trading one silent failure for another. Those refusals all exit
 * within a couple of seconds; a real dispatch stays alive for the job's whole
 * run. So a short liveness watch cleanly separates the two.
 *
 * `process.kill(pid, 0)` is the only option here: we are deliberately NOT the
 * child's parent, so there is nothing to wait() on. It throws ESRCH once the
 * pid is gone. A detached child is reaped by init, so there is no zombie to
 * mistake for a live process.
 *
 * @param {number} pid
 * @param {number} windowMs  <= 0 disables the watch (returns alive: true)
 * @param {object} [o]
 * @param {number} [o.pollMs]
 * @param {function} [o.isAlive] test seam
 * @param {function} [o.sleep]   test seam
 * @returns {Promise<{alive: boolean, waitedMs: number}>}
 */
async function waitForSettle(pid, windowMs, o = {}) {
  const pollMs = o.pollMs || 250;
  const isAlive = o.isAlive || defaultIsAlive;
  const sleep = o.sleep || ((ms) => new Promise(r => setTimeout(r, ms)));
  if (!Number.isFinite(windowMs) || windowMs <= 0) return { alive: true, waitedMs: 0 };
  let waited = 0;
  while (waited < windowMs) {
    if (!isAlive(pid)) return { alive: false, waitedMs: waited };
    await sleep(pollMs);
    waited += pollMs;
  }
  return { alive: isAlive(pid), waitedMs: waited };
}

function defaultIsAlive(p) {
  try { process.kill(p, 0); return true; } catch { return false; }
}

// True synchronous sleep — no busy-wait, no event loop. bsc-next.js's main()
// is synchronous and making it async would change its contract for every
// caller and for its own `require.main` handler, so it needs this form.
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { /* SharedArrayBuffer unavailable — degrade to no wait */ }
}

/**
 * Synchronous twin of waitForSettle, for a caller whose main() is not async.
 * Same contract, same semantics; see waitForSettle for why this exists at all.
 * @returns {{alive: boolean, waitedMs: number}}
 */
function waitForSettleSync(pid, windowMs, o = {}) {
  const pollMs = o.pollMs || 250;
  const isAlive = o.isAlive || defaultIsAlive;
  const sleep = o.sleep || sleepSync;
  if (!Number.isFinite(windowMs) || windowMs <= 0) return { alive: true, waitedMs: 0 };
  let waited = 0;
  while (waited < windowMs) {
    if (!isAlive(pid)) return { alive: false, waitedMs: waited };
    sleep(pollMs);
    waited += pollMs;
  }
  return { alive: isAlive(pid), waitedMs: waited };
}

module.exports = { spawnDetachedDispatch, stripFlag, waitForSettle, waitForSettleSync };
