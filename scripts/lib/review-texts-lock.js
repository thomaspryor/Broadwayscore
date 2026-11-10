#!/usr/bin/env node
/**
 * review-texts-lock.js — ONE machine-wide lock for writers of the local
 * review-texts clone (~/broadway-review-texts, reached via the
 * data/review-texts symlink). BRO-7171 Stage 1.
 *
 * Why: the recover-*-browser.js scripts, recover-serp-text.js and (later) the
 * nightly gap-recovery engine all read-modify-write review files and then run
 * git in the same checkout. Two of them at once raced on the same file (the
 * 2026-07-19 New Yorker run kept 6 of 22 recoveries) and on git itself (one
 * run's rebase rewriting files another run is writing). The lock serialises
 * each short critical section: one file's read -> gate -> write, one stamp,
 * one stage/commit/push checkpoint. It is NOT held for a whole run.
 *
 * Built on file-lock.js's withFileLock (its `wx` create + in-place stale steal,
 * task #1024 / BRO-6076), with a stricter contract:
 *   - the holder is identified by pid AND process start time, so a recycled
 *     PID never keeps a dead holder's lock alive, and a live holder's lock is
 *     never stolen however long it is held (staleMs 0, no age rule);
 *   - a wait that times out THROWS (ELOCKTIMEOUT) instead of running unlocked;
 *   - waits sleep (Atomics.wait), they do not spin a CPU for minutes;
 *   - re-entrant within one process (all callers are synchronous, so a nested
 *     section is always the same logical owner).
 *
 * Worst-case hold is a checkpoint push: review-texts-checkpoint.js caps
 * push-with-retry.sh's own mutex wait and deadline (PUSH_LOCK_TIMEOUT_SEC,
 * PUSH_DEADLINE_SEC) so the hold stays well under DEFAULT_TIMEOUT_MS.
 *
 * Lock file: ~/.broadwayscore-state/locks/review-texts.lock (outside every git
 * checkout), override with REVIEW_TEXTS_LOCK_PATH.
 *
 * CLI: node scripts/lib/review-texts-lock.js status
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { withFileLock, pidAlive } = require('./file-lock');

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const WAIT_MS = 500;

function lockPath() {
  return process.env.REVIEW_TEXTS_LOCK_PATH
    || path.join(os.homedir(), '.broadwayscore-state', 'locks', 'review-texts.lock');
}

/** `ps` start time of a pid, or null when the pid is gone / ps fails. */
function processStartTime(pid) {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
    return out || null;
  } catch {
    return null;
  }
}

const EMPTY_GRACE_MS = 10 * 1000;

let _selfStart;
function selfStartTime() {
  if (_selfStart === undefined) _selfStart = processStartTime(process.pid);
  return _selfStart;
}

// Per-process holder token. `run` hands it to its child in TOKEN_ENV so the
// child (a shell sync tool and the node helpers it calls) runs inside the
// parent's hold instead of deadlocking on it (BRO-7171).
const TOKEN_ENV = 'REVIEW_TEXTS_LOCK_TOKEN';
const _token = require('crypto').randomBytes(12).toString('hex');

/** Lock body: starts with the pid (file-lock.js readLockPid contract), then JSON. */
function lockBody(label) {
  return `${process.pid} ${JSON.stringify({
    pid: process.pid,
    procStart: selfStartTime(),
    host: os.hostname(),
    label,
    token: _token,
    acquiredAt: new Date().toISOString(),
  })}\n`;
}

/**
 * True when this process was started under a live hold whose token it was
 * handed (env TOKEN_ENV): an ancestor holds the lock for it.
 */
function inheritedHold() {
  const want = process.env[TOKEN_ENV];
  if (!want) return false;
  let contents;
  try { contents = fs.readFileSync(lockPath(), 'utf8'); } catch { return false; }
  const meta = parseBody(contents);
  return !!(meta && meta.token === want && holderAlive(contents));
}

function parseBody(contents) {
  const s = String(contents || '');
  const i = s.indexOf(' ');
  if (i < 0) return null;
  try { return JSON.parse(s.slice(i + 1)); } catch { return null; }
}

/**
 * Is the recorded holder still the running process that took the lock?
 * Pure apart from the injected probes (tests pass fakes).
 * @param {string} contents lock file contents
 * @param {{alive?: (pid:number)=>boolean, startOf?: (pid:number)=>string|null, host?: string, now?: number}} [probe]
 */
function holderAlive(contents, probe = {}) {
  const alive = probe.alive || pidAlive;
  const startOf = probe.startOf || processStartTime;
  const host = probe.host || os.hostname();
  const meta = parseBody(contents);
  if (!String(contents || '').trim()) {
    // file-lock creates the file before its body lands. With staleMs 0 an empty
    // file would look abandoned and a second contender could steal it from a
    // holder that is mid-create. Empty counts as held until it is 10s old.
    let mtime = probe.mtimeMs;
    if (mtime == null) { try { mtime = fs.statSync(lockPath()).mtimeMs; } catch { return false; } }
    return (probe.now || Date.now()) - mtime < EMPTY_GRACE_MS;
  }
  if (!meta || !Number.isInteger(meta.pid)) {
    // Not our format (or torn): fall back to the bare pid at its head.
    const pid = parseInt(String(contents || '').split(' ')[0], 10);
    return Number.isInteger(pid) && pid > 0 && alive(pid);
  }
  if (meta.host && meta.host !== host && alive(meta.pid)) {
    // A different hostname is usually this Mac after a network change (macOS
    // renames itself), so a pid that is dead here is a dead holder. A live pid
    // under another name could be another machine's on a synced home: give 2h.
    const t = Date.parse(meta.acquiredAt);
    return Number.isFinite(t) && (probe.now || Date.now()) - t < 2 * 60 * 60 * 1000;
  }
  if (!alive(meta.pid)) return false;
  if (!meta.procStart) return true; // could not record it: pid liveness only
  const now = startOf(meta.pid);
  return now === null ? true : now === meta.procStart; // recycled pid -> dead holder
}

let _depth = 0;
let _heldLabel = null;

/**
 * Run fn while holding the review-texts lock. Re-entrant in-process.
 * Throws ELOCKTIMEOUT when the lock stays busy past timeoutMs.
 * @template T
 * @param {string} label  who holds it (shown by `status` and in timeout errors)
 * @param {() => T} fn  synchronous critical section
 * @param {{timeoutMs?: number}} [opts]
 * @returns {T}
 */
function withReviewTextsLock(label, fn, opts = {}) {
  if (_depth > 0 || inheritedHold()) {
    _depth++;
    try { return fn(); } finally { _depth--; }
  }
  const p = lockPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  return withFileLock(p, () => {
    _depth = 1;
    _heldLabel = label;
    try { return fn(); } finally { _depth = 0; _heldLabel = null; }
  }, {
    timeoutMs: opts.timeoutMs != null ? opts.timeoutMs : DEFAULT_TIMEOUT_MS,
    staleMs: 0,
    waitMs: WAIT_MS,
    body: () => lockBody(label),
    holderAlive: (c) => holderAlive(c),
    throwOnTimeout: true,
    sleepWait: true,
  });
}

/** True while this process is inside withReviewTextsLock. */
function isHeldByMe() {
  return _depth > 0;
}

/** Current holder from disk, or null. */
function readHolder() {
  let contents;
  try { contents = fs.readFileSync(lockPath(), 'utf8'); } catch { return null; }
  const meta = parseBody(contents) || { raw: contents.trim() };
  return { ...meta, alive: holderAlive(contents) };
}

/**
 * Run a command while holding the lock; the child inherits the hold
 * (TOKEN_ENV), so its own lock calls are re-entrant. Returns the exit code.
 * @param {string[]} argv  command + args
 */
function runLocked(argv, opts = {}) {
  const { spawnSync } = require('child_process');
  return withReviewTextsLock(`run:${path.basename(argv[0] || '')} ${(argv[1] && path.basename(argv[1])) || ''}`.trim(), () => {
    const r = spawnSync(argv[0], argv.slice(1), { stdio: 'inherit', env: { ...process.env, [TOKEN_ENV]: _token } });
    if (r.error) throw r.error;
    return r.status == null ? 1 : r.status;
  }, opts);
}

module.exports = {
  withReviewTextsLock,
  runLocked,
  inheritedHold,
  isHeldByMe,
  readHolder,
  holderAlive,
  lockPath,
  processStartTime,
  TOKEN_ENV,
  DEFAULT_TIMEOUT_MS,
  _heldLabel: () => _heldLabel,
};

if (require.main === module) {
  const cmd = process.argv[2] || 'status';
  if (cmd === 'status') {
    const h = readHolder();
    console.log(h ? JSON.stringify(h, null, 2) : `free (${lockPath()})`);
  } else if (cmd === 'held') {
    // Exit 0 when an ancestor's `run` hold covers this process (shell re-exec guard).
    process.exit(inheritedHold() ? 0 : 1);
  } else if (cmd === 'run' && process.argv[3] === '--' && process.argv.length > 4) {
    try {
      process.exit(runLocked(process.argv.slice(4)));
    } catch (e) {
      console.error(`review-texts-lock run: ${e.message}`);
      process.exit(e.code === 'ELOCKTIMEOUT' ? 75 : 1);
    }
  } else {
    console.error('Usage: node scripts/lib/review-texts-lock.js status | held | run -- <cmd> [args...]');
    process.exit(2);
  }
}
