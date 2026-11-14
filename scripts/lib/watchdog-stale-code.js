'use strict';
/**
 * BRO-3904: stale-code detection for the long-running dispatch watchdog.
 *
 * `dispatch-watchdog.js --dashboard` runs for days in the crowned cmux tab.
 * Before this, nothing noticed when a fix to the watchdog (or a lib it loads)
 * merged: ensureTab() only resurrected the tab on a stale heartbeat or a dead
 * pid, so a healthy-but-stale-code process ran old code for hours.
 *
 * The identity is a CONTENT hash (sha256) of every file under scripts/ the
 * process has loaded, so a `git checkout` that only touches mtimes does not
 * restart anything. Two consumers:
 *   - the dashboard itself, once per tick, after the sweep has finished and
 *     the lock is released (decideSelfRestart): exit RESTART_EXIT_CODE, which
 *     the tab's bash loop relaunches with fresh code;
 *   - ensureTab()/--health, from OUTSIDE the process (heartbeatCodeVerdict):
 *     the heartbeat records codeRoot/codeFiles/codeHash, so the checker
 *     re-hashes the very same files and compares. It is also the only path
 *     that can retire a dashboard that predates this file (no codeHash).
 *
 * All decision functions are pure (fs access is injectable) — rule 15.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// EX_TEMPFAIL. The crowned tab's launcher loops on exactly this code.
const RESTART_EXIT_CODE = 75;
// An outside checker waits this long after the newest changed file's mtime
// before declaring a self-restarting dashboard stale: the dashboard confirms a
// change over two 90s ticks (decideSelfRestart), so it normally restarts
// itself well inside this window. ensureTab only steps in when it did not.
const OUTSIDE_STALE_GRACE_MS = 6 * 60 * 1000;
// Heartbeat modes a long-running dashboard writes. A legacy heartbeat (no
// codeHash) is only treated as stale-code in these modes: 'starting' belongs
// to ensureTab's own boot stamp and a bare --sweep run is short-lived.
const DASHBOARD_MODES = new Set(['dashboard', 'dashboard-error', 'disabled', 'restarting']);

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Pick the files that make up "the watchdog's code" out of require.cache
 * keys: everything under scriptsDir, nothing from node_modules.
 */
function selectWatchedFiles(loadedPaths, scriptsDir) {
  const root = path.resolve(scriptsDir) + path.sep;
  const out = new Set();
  for (const p of loadedPaths || []) {
    const abs = path.resolve(String(p));
    if (!abs.startsWith(root)) continue;
    if (abs.split(path.sep).includes('node_modules')) continue;
    out.add(path.relative(path.resolve(scriptsDir), abs));
  }
  return [...out].sort();
}

/** Combine a {rel: fileHash} map into one order-independent hash. */
function combineHashes(fileHashes) {
  const lines = Object.keys(fileHashes || {}).sort().map(rel => `${rel}:${fileHashes[rel]}`);
  return sha256(lines.join('\n'));
}

/**
 * Hash each relative file under root. A missing/unreadable file hashes as
 * 'missing' (a deleted lib is a change). newestMtimeMs is the newest mtime
 * among the files (for the outside grace window).
 */
function computeCodeIdentity(root, relFiles, { readFile = fs.readFileSync, stat = fs.statSync } = {}) {
  const files = {};
  let newestMtimeMs = 0;
  for (const rel of [...new Set(relFiles || [])].sort()) {
    const abs = path.join(root, rel);
    try { files[rel] = sha256(readFile(abs)); } catch { files[rel] = 'missing'; }
    try { newestMtimeMs = Math.max(newestMtimeMs, stat(abs).mtimeMs || 0); } catch { /* missing */ }
  }
  return { hash: combineHashes(files), files, newestMtimeMs };
}

/** Rel paths whose hash differs (or that appeared/disappeared). */
function changedFiles(recordedFiles, currentFiles) {
  const a = recordedFiles || {};
  const b = currentFiles || {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter(k => a[k] !== b[k]).sort();
}

/**
 * The dashboard's own per-tick decision. Requires the SAME changed hash on two
 * consecutive checks before restarting, so a checkout caught half-written
 * does not boot a broken mix of old and new files.
 *   → { action: 'none' | 'pending' | 'restart', pendingHash }
 * Callers pass back `pendingHash` on the next tick.
 */
function decideSelfRestart({ startupHash, currentHash, pendingHash = null }) {
  if (!startupHash || !currentHash || currentHash === startupHash) return { action: 'none', pendingHash: null };
  if (pendingHash === currentHash) return { action: 'restart', pendingHash: currentHash };
  return { action: 'pending', pendingHash: currentHash };
}

/**
 * Fields the dashboard adds to every heartbeat so an outside checker can
 * re-hash the same files. codeFiles carries the per-file hashes so the
 * checker can name what changed.
 */
function heartbeatCodeFields(identity, root) {
  if (!identity || !identity.hash) return {};
  return { codeHash: identity.hash, codeRoot: root, codeFiles: identity.files };
}

/**
 * Outside verdict on a heartbeat: is the process that wrote it running code
 * that no longer matches disk?
 *   hb      — parsed heartbeat
 *   compute — (root, relFiles) => identity (computeCodeIdentity, injectable)
 *   now     — ms
 * → { stale: bool, reason, changed: [rel] }
 */
function heartbeatCodeVerdict(hb, { compute = computeCodeIdentity, now = Date.now(), graceMs = OUTSIDE_STALE_GRACE_MS } = {}) {
  if (!hb || typeof hb !== 'object') return { stale: false, reason: 'no-heartbeat', changed: [] };
  if (!hb.codeHash) {
    // A dashboard that predates BRO-3904 can never notice its own staleness;
    // only ensureTab can retire it.
    if (DASHBOARD_MODES.has(hb.mode)) return { stale: true, reason: 'legacy-no-code-identity', changed: [] };
    return { stale: false, reason: 'not-a-dashboard', changed: [] };
  }
  if (!hb.codeRoot || !hb.codeFiles || typeof hb.codeFiles !== 'object') {
    return { stale: false, reason: 'incomplete-identity', changed: [] };
  }
  const current = compute(hb.codeRoot, Object.keys(hb.codeFiles));
  if (current.hash === hb.codeHash) return { stale: false, reason: 'current', changed: [] };
  const changed = changedFiles(hb.codeFiles, current.files);
  // Give the dashboard's own two-tick self-restart a chance first.
  if (current.newestMtimeMs && now - current.newestMtimeMs < graceMs) {
    return { stale: false, reason: 'changed-within-grace', changed };
  }
  return { stale: true, reason: 'code-changed', changed };
}

/** The crowned tab's launcher: relaunch on RESTART_EXIT_CODE, stop on anything else. */
function dashboardLauncherScript(scriptPath) {
  return [
    '#!/bin/bash',
    '# BRO-3904: the dashboard exits ' + RESTART_EXIT_CODE + ' when its code changed on disk; relaunch it.',
    'while :; do',
    `  WATCHDOG_LAUNCHER=1 node ${scriptPath} --dashboard`,
    '  rc=$?',
    `  [ "$rc" -eq ${RESTART_EXIT_CODE} ] || exit "$rc"`,
    '  sleep 2',
    'done',
    '',
  ].join('\n');
}

module.exports = {
  RESTART_EXIT_CODE, OUTSIDE_STALE_GRACE_MS, DASHBOARD_MODES,
  selectWatchedFiles, combineHashes, computeCodeIdentity, changedFiles,
  decideSelfRestart, heartbeatCodeFields, heartbeatCodeVerdict, dashboardLauncherScript,
};
