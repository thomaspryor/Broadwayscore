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
      // BRO-8288: outlet lanes hold their own locks. Global first, lanes second (a lane
      // takes lanes first, global second), so of any pair at least one sees the other.
      const lane = readLaneHolders().find((h) => h.alive);
      if (lane) { try { fs.unlinkSync(p); } catch { /* gone */ } throw new RunLockBusyError(lane); }
      held = { path: p, body };
      process.once('exit', release);
      return release;
    }
    if (fs.existsSync(p)) break; // live holder (or a concurrent claim won): busy
  }
  throw new RunLockBusyError(parse((() => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } })()));
}

// ---- BRO-8288: parallel outlet lanes ---------------------------------------
// A lane runs a disjoint set of outlets under per-outlet lock files (one dir next
// to the whole-run lock) instead of the whole-run lock, so lanes run side by side.
// The whole-run lock (nightly, recover-*-browser.js, an unscoped driver) is refused
// while any lane lives, and a lane is refused while the whole-run lock is live.
// Exactly one lane may own the 'browser' key (one Chrome); others run browser-less.
const BROWSER_KEY = '__browser__';
let heldLanes = []; // [{ path, body, rel }]

function lanesDir() { return `${runLockPath()}.lanes`; }
const laneFile = (key) => path.join(lanesDir(), `${encodeURIComponent(String(key))}.lock`);

function laneBody(label, key) {
  const { processStartTime } = require('./review-texts-lock');
  return `${process.pid} ${JSON.stringify({ pid: process.pid, procStart: processStartTime(process.pid), host: os.hostname(), label, lane: key, acquiredAt: new Date().toISOString() })}\n`;
}

/**
 * Take per-outlet lane locks (all or none) plus, when wanted, the single browser key.
 * @param {string} label
 * @param {string[]} outlets registry ids, non-empty
 * @param {{browser?: boolean, probe?: object}} [opts] browser: also try the one-Chrome key
 * @returns {{release: () => void, browser: boolean}} browser=false when another lane owns Chrome
 * @throws RunLockBusyError when an outlet is taken or the whole-run lock is live
 */
function acquireLaneLock(label, outlets, opts = {}) {
  const ids = [...new Set((outlets || []).map(String).filter(Boolean))].sort();
  if (!ids.length) throw new Error('acquireLaneLock: a lane needs at least one outlet (an unscoped run takes the whole-run lock)');
  const { holderAlive } = require('./review-texts-lock');
  const { tryAcquireFileLock } = require('./file-lock');
  fs.mkdirSync(lanesDir(), { recursive: true });
  const taken = [];
  const take = (key) => {
    const f = laneFile(key);
    const body = laneBody(label, key);
    const rel = tryAcquireFileLock(f, { body: () => body, holderAlive: (c, m) => holderAlive(c, { ...m, ...(opts.probe || {}) }) });
    if (!rel) return null;
    const h = { path: f, body, rel };
    taken.push(h);
    return h;
  };
  const undo = () => { for (const h of taken.splice(0)) dropLane(h); };
  for (const id of ids) {
    if (!take(id)) {
      const holder = (readLaneHolders().find((x) => x.lane === id)) || null;
      undo();
      throw new RunLockBusyError(holder);
    }
  }
  const whole = readRunHolder();
  if (whole && whole.alive) { undo(); throw new RunLockBusyError(whole); }
  const gotBrowser = opts.browser ? !!take(BROWSER_KEY) : false;
  heldLanes.push(...taken);
  process.once('exit', releaseLanes);
  return { release: releaseLanes, browser: gotBrowser };
}

function dropLane(h) {
  try { if (fs.readFileSync(h.path, 'utf8') === h.body) fs.unlinkSync(h.path); } catch { /* gone */ }
}
function releaseLanes() { for (const h of heldLanes.splice(0)) dropLane(h); }

/** Every lane lock file (outlet keys + the browser key) with liveness. */
function readLaneHolders() {
  let names = [];
  try { names = fs.readdirSync(lanesDir()).filter((n) => n.endsWith('.lock')); } catch { return []; }
  const { holderAlive } = require('./review-texts-lock');
  const out = [];
  for (const n of names) {
    const f = path.join(lanesDir(), n);
    let c; let mtimeMs = Date.now();
    try { c = fs.readFileSync(f, 'utf8'); mtimeMs = fs.statSync(f).mtimeMs; } catch { continue; }
    out.push({ ...(parse(c) || { raw: c.trim() }), lane: (parse(c) || {}).lane || n.replace(/\.lock$/, ''), alive: holderAlive(c, { mtimeMs }) });
  }
  return out;
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

module.exports = { acquireRunLock, releaseRunLock: release, acquireLaneLock, releaseLanes, readLaneHolders, lanesDir, BROWSER_KEY, readRunHolder, runLockPath, RunLockBusyError };

if (require.main === module) {
  const h = readRunHolder();
  const lanes = readLaneHolders().filter((x) => x.alive);
  console.log(h ? JSON.stringify(h, null, 2) : `no whole-run holder (${runLockPath()})`);
  if (lanes.length) console.log(`live lanes: ${JSON.stringify(lanes.map((x) => ({ lane: x.lane, pid: x.pid, label: x.label })))}`);
}
