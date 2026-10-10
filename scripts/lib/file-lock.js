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
 * stat+pid read is stale the instant another process acts on it, so a naive
 * "rename it away" claim can grab a lock that was live a moment ago — and
 * doing that necessarily leaves lockPath briefly ABSENT, exactly the window
 * a completely unrelated waiter's normal `wx` create can slip into, producing
 * two simultaneous holders. See claimStaleLockInPlace()'s docstring for why
 * the fix claims in place (never unlinks/renames lockPath) instead of trying
 * to patch that window shut.
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
 * Claims lockPath in place when it is still genuinely stale at the moment of
 * the claim (not merely at the moment the caller's stat/pid check ran),
 * WITHOUT ever unlinking or renaming lockPath — so lockPath is never
 * observably absent to anyone (task #1024's actual ~12%-repro two-holders
 * bug: a rename-away steal briefly emptied lockPath, and a totally unrelated
 * waiter's plain `wx` create landed in that gap and became a second
 * simultaneous holder — no gate or re-check on the rename side closes that,
 * because the absence itself is the hazard, not what's judged before it).
 *
 * Two things make this safe:
 *
 * 1. `stealGatePath` (acquired with `wx`, exclusive) serializes stealers, so
 *    at most one process is ever mid-claim at a time. Without it, two
 *    processes could each judge the lock stale, each overwrite lockPath in
 *    place, and each read back a match against ITS OWN write if the reads
 *    happen to interleave with the writes just wrong — "write then read
 *    back" alone is not enough; the whole write+verify must be one
 *    process's exclusive turn. withFileLock's main loop also refuses its
 *    own `wx` create while the gate exists, purely to avoid wasted spins —
 *    NOT for correctness, since lockPath is never absent during a claim
 *    (see below).
 * 2. The claim overwrites lockPath's CONTENT in place (`fs.writeFileSync`
 *    with no `wx`/`ax` flag — open+truncate+write, never unlink+recreate),
 *    so the directory entry exists continuously throughout. Any other
 *    process's `wx` create — gate-aware or not — requires lockPath to be
 *    ABSENT to succeed; since it never is, no interleaving can let a second
 *    process in, unlike the earlier rename-based version of this fix.
 *
 * Returns true iff this process now legitimately holds the lock (caller
 * should treat this exactly like a successful `wx` create); false means
 * lockPath is untouched (caller should wait and recheck).
 */
function claimStaleLockInPlace(lockPath, stealGatePath, staleMs) {
  try {
    fs.writeFileSync(stealGatePath, `${process.pid}\n`, { flag: 'wx' });
  } catch {
    return false; // someone else is already mid-claim — let them finish
  }
  try {
    const st = fs.statSync(lockPath);
    const staleByAge = Date.now() - st.mtimeMs > staleMs;
    if (!staleByAge || pidAlive(readLockPid(lockPath))) return false; // no longer stale

    const claim = `${process.pid} ${new Date().toISOString()}\n`;
    fs.writeFileSync(lockPath, claim);
    // Confirm our write landed last. While we hold the gate, no other
    // stealer can be mid-claim, and a legitimate holder never overwrites its
    // own lock file in place, so this can only mismatch in a scenario this
    // helper already treats as acceptable risk (pidAlive false negative —
    // see the file docstring); it costs one read to verify anyway.
    return fs.readFileSync(lockPath, 'utf8') === claim;
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
      // Someone else is mid-claim. This is purely to avoid a wasted `wx`
      // attempt while that's happening — lockPath itself is never absent
      // during a claim (see claimStaleLockInPlace's docstring), so this
      // check is an optimization, not a correctness requirement.
      //
      // Deliberately NOT self-healing an abandoned gate here: a stat-then-act
      // cleanup (age+pid check, then unlink) has the exact same TOCTOU shape
      // as the original bug — between the check and the unlink, the real
      // holder can release the gate normally and a brand-new claimer can
      // acquire it via `wx`, and the cleanup would then delete that live
      // gate, letting a second claimer in. Fencing that properly means
      // reimplementing the same rename-and-verify dance this fix removed in
      // favor of the simpler in-place claim — not worth it for a window this
      // narrow: the gate is only ever held for a handful of synchronous fs
      // calls (no work happens while holding it), so a crash exactly there is
      // far rarer than a crash during the real critical section, which this
      // helper already only guards with a timeout, not a lock-specific
      // self-heal. An abandoned gate degrades to the SAME fail-open path as
      // any other unavailability here: callers wait out `timeoutMs` and then
      // run with held=false (see the docstring's fail-open philosophy).
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
          if (claimStaleLockInPlace(lockPath, stealGatePath, staleMs)) { held = true; break; }
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
