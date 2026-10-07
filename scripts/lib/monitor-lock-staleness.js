#!/usr/bin/env node
/**
 * monitor-lock-staleness — pure decision function for #476.
 *
 * The opening-night monitor's lock (data/opening-night-monitor/monitor.lock)
 * must never be judged stale/fresh by the LOCK DIRECTORY's mtime — any
 * unrelated process that touches/stats the dir (a smoketest, an `ls`/`find`
 * sweep) resets mtime without the monitor doing anything, which is exactly
 * what silently skipped 5 planned tier-3 attempts on 2026-07-26. The only
 * trustworthy clock is meta.json's `launchedAt`, written once by
 * opening-night-monitor-launch.js at launch time and never touched again.
 *
 * ship-check (codex) found two follow-on bugs fixed here:
 *  - the caller must default to "not fresh" (run the full night) on ANY
 *    ambiguous read — a corrupt/missing meta.json must never be able to
 *    silently reintroduce the skip.
 *  - mkdir (the atomic lock) happens BEFORE meta.json is written (preflight
 *    + cmux launch can take up to ~90s) — a meta.json read during that
 *    narrow window must not be treated as a dead orphan. A lock dir younger
 *    than LAUNCH_GRACE_MS is presumed to be mid-launch and treated as fresh
 *    (skip once more; the next tick either sees meta.json or reclaims it).
 */

const fs = require('fs');
const path = require('path');

const STALE_AGE_MS = 20 * 3600 * 1000; // matches the monitor's own ~4-6h max window with generous margin
const LAUNCH_GRACE_MS = 5 * 60 * 1000;

/**
 * @param {string} lockDirPath absolute path to the monitor.lock directory
 * @param {number} [now] injectable clock for tests
 * @returns {boolean} true if the lock is FRESH (owning monitor window still open — skip the executor)
 */
function isLockFresh(lockDirPath, now = Date.now()) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(lockDirPath, 'meta.json'), 'utf8'));
    const launchedAt = Date.parse(meta.launchedAt);
    if (!Number.isFinite(launchedAt)) return false;
    return (now - launchedAt) <= STALE_AGE_MS;
  } catch {
    // meta.json missing or corrupt. Could be a genuine orphan, or the
    // launcher mid-launch (mkdir happens before meta.json is written) —
    // use the lock dir's own age as a narrow fallback signal ONLY here.
    try {
      const dirAgeMs = now - fs.statSync(lockDirPath).mtimeMs;
      return dirAgeMs < LAUNCH_GRACE_MS;
    } catch {
      return false;
    }
  }
}

module.exports = { isLockFresh, STALE_AGE_MS, LAUNCH_GRACE_MS };

if (require.main === module) {
  const lockDirPath = process.argv[2];
  if (!lockDirPath) { console.error('usage: monitor-lock-staleness.js <lock-dir-path>'); process.exit(1); }
  console.log(isLockFresh(lockDirPath) ? 'FRESH' : 'STALE');
}
