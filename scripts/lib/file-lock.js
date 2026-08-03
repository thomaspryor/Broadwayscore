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

/** Best-effort PID parse from a lock file's `${pid} ${isoTimestamp}` body. */
function readLockPid(lockPath) {
  try {
    const pid = parseInt(fs.readFileSync(lockPath, 'utf8').split(' ')[0], 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}

function withFileLock(lockPath, fn, opts = {}) {
  const { timeoutMs = 30000, staleMs = 5 * 60 * 1000, waitMs = 100 } = opts;
  const deadline = Date.now() + timeoutMs;
  let held = false;
  while (Date.now() < deadline) {
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
          // NOT unlinkSync: between judging the lock stale and deleting it, the
          // original owner can release and a NEW process can take a fresh lock
          // at the same path — the blind unlink would then delete a LIVE lock
          // and two writers would run concurrently, which is the exact failure
          // this function exists to prevent. rename(2) is atomic, so when
          // several processes race to steal the same stale lock exactly one
          // rename succeeds; the losers get ENOENT and simply retry.
          const stealPath = `${lockPath}.stale-${process.pid}-${st.mtimeMs}`;
          fs.renameSync(lockPath, stealPath); // throws ENOENT if someone else won
          try { fs.unlinkSync(stealPath); } catch { /* best-effort */ }
          continue; // retry the wx create immediately
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
