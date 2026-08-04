/**
 * Generic cross-process exclusive file lock (task #923).
 *
 * Originally lived inside gap-audit-merge.js, scoped to one file
 * (show-review-gap.json). It now locks a second, unrelated file
 * (gap-audit-checkpoint.json) — a lock helper whose docstring says "for
 * merging show-review-gap.json" but is used for something else is exactly the
 * kind of drift that hides a missing lock call at the next call site. Moved
 * here so the helper's scope matches its actual usage.
 *
 * `wx` open is atomic on POSIX, so exactly one process wins the create.
 *
 * Fail-open on every uncertainty: a lock we cannot create after the timeout is
 * broken (assumed stale from a killed process) and the work proceeds. Blocking
 * a caller forever on a leftover lockfile would be a worse failure than the
 * race it prevents.
 *
 * Staleness is judged by TWO signals, not one: lock age (mtime) AND whether
 * the recorded holder PID is still alive. Age alone is wrong — the lock's
 * mtime is stamped once at acquire and never refreshed, so a critical section
 * that legitimately runs longer than staleMs would get its LIVE lock stolen
 * out from under it (a real bug in the original age-only version: see #923).
 * PID liveness alone is also wrong — a fresh lock from a process that's about
 * to start real work would be stealable the instant its PID happened to
 * collide with a dead one. Both signals must agree the holder is gone before
 * a waiter steals: age > staleMs AND the holder PID is not running.
 *
 * PID liveness assumes the lock file and the reader share a PID namespace
 * (same host). A lock planted by a process on a different machine (e.g. a
 * GitHub Actions runner racing a local Mac Studio run) is judged on age alone
 * once its PID reads as "not alive" here — same fail-toward-availability
 * tradeoff as the rest of this helper, and the existing multi-minute default
 * staleMs makes that window small in practice.
 *
 * BREAKING a stale lock is itself racy across processes (task #1024): a
 * stat+pid read is stale the instant another process acts on it, so a
 * "rename it away" claim can grab a lock that was live a moment ago and
 * briefly leave lockPath absent — exactly the window a completely unrelated
 * waiter's normal `wx` create can slip into, producing two simultaneous
 * holders. See breakStaleLock()'s docstring for how the steal gate closes
 * that window.
 *
 * @param {string} lockPath
 * @param {() => any} fn                 executed while holding the lock
 * @param {{timeoutMs?: number, staleMs?: number, waitMs?: number}} [opts]
 */
'use strict';

const fs = require('fs');

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (err) { return err.code === 'EPERM'; } // exists, just not ours
}

function parsePid(contents) {
  const pid = parseInt(String(contents).split(' ')[0], 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/** Best-effort PID parse from a lock file's `${pid} ${isoTimestamp}` body. */
function readLockPid(lockPath) {
  try { return parsePid(fs.readFileSync(lockPath, 'utf8')); }
  catch { return null; }
}

/**
 * Breaks lockPath ONLY if it is still genuinely stale at the moment of the
 * break, not merely at the moment the caller's stat/pid check ran, AND
 * without ever letting an unrelated waiter's `wx` create observe lockPath as
 * absent while a live lock legitimately exists (task #1024's actual
 * ~12%-repro two-holders bug).
 *
 * A stat+pid read is out of date the instant something else acts on it.
 * Renaming lockPath away based on that read can grab a lock that was live a
 * moment ago (the real holder finished and a brand-new process claimed a
 * fresh one in the gap); the code below already detects that mismatch and
 * puts the live lock back rather than deleting it. But "rename away, look,
 * maybe rename back" necessarily has lockPath briefly ABSENT between the two
 * renames — and that absence is externally visible: any of the other waiters
 * in withFileLock's main loop is independently retrying a plain `wx` create
 * on lockPath every `waitMs`, with no idea a steal is in flight, and a `wx`
 * create landing in that gap succeeds (nothing exists there yet), producing
 * a second, simultaneous holder while the original is still running.
 *
 * `stealGatePath` closes that: withFileLock's main loop refuses to attempt
 * its `wx` create while the gate file exists (see the check there), and this
 * function holds the gate for the ENTIRE duration of the risky
 * rename-then-maybe-restore sequence, releasing it only once lockPath is
 * back in a stable state. The gate itself is acquired with `wx` (exclusive),
 * so at most one process is ever mid-steal at a time — steals are
 * serialized, which is fine since a steal is rare and fast; only the fast,
 * uncontended acquire path needs to stay lock-free.
 *
 * Returns true iff it actually removed a stale lock (caller should retry the
 * `wx` create immediately); false means lockPath is untouched (caller should
 * wait and recheck).
 */
function breakStaleLock(lockPath, stealGatePath, staleMs) {
  try {
    fs.writeFileSync(stealGatePath, `${process.pid}\n`, { flag: 'wx' });
  } catch {
    return false; // someone else is already mid-steal — let them finish
  }
  try {
    const st = fs.statSync(lockPath);
    const staleByAge = Date.now() - st.mtimeMs > staleMs;
    if (!staleByAge || pidAlive(readLockPid(lockPath))) return false; // no longer stale

    const stealPath = `${lockPath}.stale-${process.pid}-${st.mtimeMs}`;
    let stolenMtimeMs, stolenContents;
    try {
      fs.renameSync(lockPath, stealPath); // throws ENOENT if someone else claimed it first
      stolenMtimeMs = fs.statSync(stealPath).mtimeMs;
      stolenContents = fs.readFileSync(stealPath, 'utf8');
    } catch {
      return false;
    }
    // Re-judge staleness from what we actually grabbed, not the earlier
    // read — a holder that renewed its own lock between our stat and our
    // rename must not be judged by a mtime/pid that's no longer even its own.
    const stillStale = Date.now() - stolenMtimeMs > staleMs && !pidAlive(parsePid(stolenContents));
    if (stillStale) {
      try { fs.unlinkSync(stealPath); } catch { /* best-effort */ }
      return true; // genuinely won the steal
    }
    // What we grabbed is live (a new process claimed a fresh lock in the gap
    // between our stat and our rename) — put it back. No other waiter could
    // have wx-created into the gap while we held the gate, so this restore
    // always lands on an empty path.
    try { fs.renameSync(stealPath, lockPath); } catch { /* best-effort */ }
    return false;
  } finally {
    try { fs.unlinkSync(stealGatePath); } catch { /* best-effort */ }
  }
}

function withFileLock(lockPath, fn, opts = {}) {
  const { timeoutMs = 30000, staleMs = 5 * 60 * 1000, waitMs = 100 } = opts;
  const stealGatePath = `${lockPath}.steal-gate`;
  const deadline = Date.now() + timeoutMs;
  let held = false;
  while (Date.now() < deadline) {
    if (fs.existsSync(stealGatePath)) {
      // Someone else is mid-steal, which means lockPath may be transiently
      // absent — don't race a `wx` create into that window (task #1024).
      const until = Date.now() + waitMs;
      while (Date.now() < until) { /* spin */ }
      continue;
    }
    try {
      fs.writeFileSync(lockPath, `${process.pid} ${new Date().toISOString()}\n`, { flag: 'wx' });
      held = true;
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') { held = false; break; } // unwritable dir etc — proceed unlocked
      try {
        const st = fs.statSync(lockPath);
        const staleByAge = Date.now() - st.mtimeMs > staleMs;
        // Both signals must agree — see docstring above.
        if (staleByAge && !pidAlive(readLockPid(lockPath))) {
          if (breakStaleLock(lockPath, stealGatePath, staleMs)) continue; // retry the wx create immediately
        }
      } catch { /* vanished or lost the steal race — fall through and retry */ }
      // Busy-wait: this runs at most once per lock acquisition on a
      // millisecond-scale critical section, so a short synchronous spin is
      // simpler than making the whole write path async.
      const until = Date.now() + waitMs;
      while (Date.now() < until) { /* spin */ }
    }
  }
  try {
    return fn(held);
  } finally {
    // Only ever released when THIS process won the `wx` create above, so this
    // can't remove a lock belonging to someone else.
    if (held) { try { fs.unlinkSync(lockPath); } catch { /* best-effort */ } }
  }
}

module.exports = { withFileLock, pidAlive, readLockPid };
