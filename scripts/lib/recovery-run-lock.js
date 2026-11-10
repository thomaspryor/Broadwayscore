'use strict';
/**
 * recovery-run-lock.js — ONE whole-run lock for review-text recovery runs
 * (BRO-7171 Stage 3). review-texts-lock.js serialises each short write/push
 * section; it is deliberately not held for a run, so the nightly
 * gap-recovery job and a manual recover-*-browser.js could still interleave:
 * two headed Chromes on the same subscriber login, two runs' pending-push
 * retries and checkpoints racing, and two ledgers of attempts on one file.
 * This lock makes the runs themselves mutually exclusive.
 *
 * Non-blocking: a second run does not wait, it refuses (RunLockBusyError) and
 * says who holds the lock. The holder is pid + process start time (the same
 * liveness rule as review-texts-lock.holderAlive), so a crashed run's lock is
 * stale at once and a recycled pid never keeps it alive. Released on exit.
 *
 * Lock file: ~/.broadwayscore-state/locks/gap-recovery-run.lock
 * (outside every git checkout), override with RECOVERY_RUN_LOCK_PATH.
 * CLI: node scripts/lib/recovery-run-lock.js status
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

class RunLockBusyError extends Error {
  constructor(holder) {
    super(`another review-text recovery run holds the run lock: ${holder ? `${holder.label || '?'} (pid ${holder.pid}, since ${holder.acquiredAt || '?'})` : 'unknown holder'}`);
    this.name = 'RunLockBusyError';
    this.code = 'ERUNLOCKBUSY';
    this.holder = holder || null;
  }
}

function runLockPath() {
  return process.env.RECOVERY_RUN_LOCK_PATH
    || path.join(os.homedir(), '.broadwayscore-state', 'locks', 'gap-recovery-run.lock');
}

let held = null; // { path, body }

function parse(contents) {
  const s = String(contents || '');
  const i = s.indexOf(' ');
  if (i < 0) return null;
  try { return JSON.parse(s.slice(i + 1)); } catch { return null; }
}

/**
 * Take the run lock or throw RunLockBusyError. Re-entrant in-process.
 * @param {string} label who is running (shown to the refused run)
 * @param {{probe?: object}} [opts] liveness probe override (tests)
 * @returns {() => void} release
 */
function acquireRunLock(label, opts = {}) {
  const p = runLockPath();
  if (held && held.path === p) return release;
  const { holderAlive, processStartTime } = require('./review-texts-lock');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const body = `${process.pid} ${JSON.stringify({ pid: process.pid, procStart: processStartTime(process.pid), host: os.hostname(), label, acquiredAt: new Date().toISOString() })}\n`;
  // A dead holder's lock is claimed in place under file-lock's steal gate
  // (BRO-7171): read-compare-unlink was not atomic, so a second waiter could
  // unlink the first one's fresh lock and two drivers would run (the daily
  // ceiling overshoot needed exactly that).
  const { tryAcquireFileLock } = require('./file-lock');
  for (let attempt = 0; attempt < 3; attempt++) {
    const rel = tryAcquireFileLock(p, {
      body: () => body,
      holderAlive: (contents, m) => holderAlive(contents, { ...m, ...(opts.probe || {}) }),
    });
    if (rel) {
      held = { path: p, body };
      process.once('exit', release);
      return release;
    }
    if (fs.existsSync(p)) break; // live holder (or a concurrent claim won): busy
  }
  throw new RunLockBusyError(parse((() => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } })()));
}

function release() {
  if (!held) return;
  try { if (fs.readFileSync(held.path, 'utf8') === held.body) fs.unlinkSync(held.path); } catch { /* gone */ }
  held = null;
}

function readRunHolder() {
  let contents;
  try { contents = fs.readFileSync(runLockPath(), 'utf8'); } catch { return null; }
  const { holderAlive } = require('./review-texts-lock');
  let mtimeMs = Date.now();
  try { mtimeMs = fs.statSync(runLockPath()).mtimeMs; } catch { /* gone */ }
  return { ...(parse(contents) || { raw: contents.trim() }), alive: holderAlive(contents, { mtimeMs }) };
}

module.exports = { acquireRunLock, releaseRunLock: release, readRunHolder, runLockPath, RunLockBusyError };

if (require.main === module) {
  const h = readRunHolder();
  console.log(h ? JSON.stringify(h, null, 2) : `free (${runLockPath()})`);
}
