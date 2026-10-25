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
 * The callback always runs, receiving held=false if acquisition times out.
 * Callers that require mutual exclusion must skip their work in that case.
 * Abandoned locks are claimed before invoking the callback with held=true.
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
 * stat+pid read is stale the instant another process acts on it, so a naive
 * "rename it away" claim can grab a lock that was live a moment ago — and
 * doing that necessarily leaves lockPath briefly ABSENT, exactly the window
 * a completely unrelated waiter's normal `wx` create can slip into, producing
 * two simultaneous holders. See claimStaleLockInPlace()'s docstring for why
 * the fix claims in place (never unlinks/renames lockPath) instead of trying
 * to patch that window shut.
 *
 * Callers with strictly bounded synchronous critical sections may opt into
 * abandonedMs: an age limit that also recovers locks with recycled live PIDs.
 * Other callers retain the age AND dead-PID rule above.
 *
 * @param {string} lockPath
 * @param {(held: boolean) => any} fn
 * @param {{timeoutMs?: number, staleMs?: number, waitMs?: number, abandonedMs?: number}} [opts]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

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

function isStale(lockPath, staleMs, abandonedMs) {
  const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
  return ageMs > abandonedMs || (ageMs > staleMs && !pidAlive(readLockPid(lockPath)));
}

/**
 * New gates are directories containing a unique owner marker. A delayed
 * cleaner removes only marker names it observed as stale, then rmdir refuses
 * to remove a populated successor gate. Ordinary stat+unlink of a gate FILE
 * could instead delete a fresh successor between those calls (BRO-6076).
 * Legacy file gates can be unlinked safely because unlink cannot remove a
 * directory successor. All contenders must use this directory protocol.
 */
function clearAbandonedGate(gatePath, staleMs, abandonedMs) {
  try {
    const st = fs.statSync(gatePath);
    if (st.isDirectory()) {
      const markers = fs.readdirSync(gatePath);
      if (!markers.length && Date.now() - st.mtimeMs <= Math.min(staleMs, abandonedMs)) return;
      for (const marker of markers) {
        const markerPath = path.join(gatePath, marker);
        try {
          if (isStale(markerPath, staleMs, abandonedMs)) fs.unlinkSync(markerPath);
        } catch { /* vanished or unreadable; never remove a whole directory */ }
      }
      fs.rmdirSync(gatePath); // only succeeds if no fresh owner marker exists
    } else {
      if (!isStale(gatePath, staleMs, abandonedMs)) return;
      fs.unlinkSync(gatePath); // EISDIR if another cleaner installed a successor
    }
    console.error(`[file-lock] cleared abandoned steal gate: ${gatePath}`);
  } catch { /* live successor, vanished gate or inaccessible path; retry normally */ }
}

/**
 * Serialize stale claims under a directory gate and overwrite the main lock
 * in place. Never unlink/rename lockPath before claiming: its absence would
 * allow a normal wx contender to become a second holder (task #1024).
 */
function claimStaleLockInPlace(lockPath, stealGatePath, staleMs, abandonedMs) {
  // A fresh name per attempt also fences a cleaner that observed a previous
  // generation of this directory. Release must never recursively remove it.
  const marker = path.join(stealGatePath, randomUUID());
  try { fs.mkdirSync(stealGatePath); }
  catch { return false; }
  try {
    fs.writeFileSync(marker, `${process.pid} ${new Date().toISOString()}\n`, { flag: 'wx' });
    // A cleaner may have removed an EMPTY gate between mkdir and this write,
    // merging us into a successor directory. Only a sole marker may proceed;
    // any second marker must withdraw before its holder can claim the lock.
    const owners = fs.readdirSync(stealGatePath);
    if (owners.length !== 1 || owners[0] !== path.basename(marker)) return false;
    if (!isStale(lockPath, staleMs, abandonedMs)) return false;

    const claim = `${process.pid} ${new Date().toISOString()}\n`;
    fs.writeFileSync(lockPath, claim);
    const held = fs.readFileSync(lockPath, 'utf8') === claim;
    if (held) console.error(`[file-lock] recovered abandoned lock in place: ${lockPath}`);
    return held;
  } finally {
    try { fs.unlinkSync(marker); } catch { /* best-effort */ }
    try { fs.rmdirSync(stealGatePath); } catch { /* a successor owns this directory */ }
  }
}

function withFileLock(lockPath, fn, opts = {}) {
  const { timeoutMs = 30000, staleMs = 5 * 60 * 1000, waitMs = 100, abandonedMs = Infinity } = opts;
  const stealGatePath = `${lockPath}.steal-gate`;
  const deadline = Date.now() + timeoutMs;
  let held = false;
  // Guarantee one real acquire attempt: a tiny timeoutMs (BRO-5979 uses 1) can
  // already be past by the first check on a slow runner, which skipped the
  // acquire entirely and reported a free lock as busy (BRO-6189). Clearing an
  // abandoned steal gate does not use the attempt up; waiting on a live one does.
  let mustTry = true;
  while (mustTry || Date.now() < deadline) {
    if (fs.existsSync(stealGatePath)) {
      clearAbandonedGate(stealGatePath, staleMs, abandonedMs);
      if (!fs.existsSync(stealGatePath)) continue;
      mustTry = false;
      const until = Date.now() + waitMs;
      while (Date.now() < until) { /* spin */ }
      continue;
    }
    mustTry = false;
    try {
      fs.writeFileSync(lockPath, `${process.pid} ${new Date().toISOString()}\n`, { flag: 'wx' });
      held = true;
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') { held = false; break; } // unwritable dir etc — proceed unlocked
      try {
        if (isStale(lockPath, staleMs, abandonedMs)) {
          if (claimStaleLockInPlace(lockPath, stealGatePath, staleMs, abandonedMs)) { held = true; break; }
        }
      } catch { /* vanished or lost the claim race — fall through and retry */ }
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
    // held is only ever true when THIS process itself just won the lock —
    // either the `wx` create above, or claimStaleLockInPlace()'s in-place
    // overwrite — so this can't remove a lock belonging to someone else.
    if (held) { try { fs.unlinkSync(lockPath); } catch { /* best-effort */ } }
  }
}

module.exports = { withFileLock, pidAlive, readLockPid };
