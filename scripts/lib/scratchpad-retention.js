/**
 * scratchpad-retention — bounded pruning for Claude Code scratchpad dirs
 * (/private/tmp/claude-<uid>/<project>/<session-id>/, BRO-2572, cousin of
 * BRO-2258's job-log-retention). One session dir is added per session and
 * nothing removed them, so /private/tmp grew until the disk filled.
 *
 * Unlike job logs, a scratchpad can belong to a session that is running right
 * now but idle (long review, paused mid-task), so age alone is never enough.
 * A session dir is deleted only when ALL hold:
 *   1. its newest file/dir mtime (whole tree) is older than maxAgeMs;
 *   2. it is not the current session (CLAUDE_CODE_SESSION_ID);
 *   3. no running process mentions its path or its session id (liveness).
 * Any doubt (stat error, ps failure) keeps the dir. Fail-open for the hook:
 * nothing here throws, and a missing root is a no-op.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { pruneDue } = require('./job-log-retention.js');

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h idle
const DEFAULT_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h between prunes
const DEFAULT_MARKER_PATH = path.join(__dirname, '..', '..', 'data', 'audit', 'scratchpad-prune.lock');

function defaultRoots() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : '';
  return [`/private/tmp/claude-${uid}`, `/tmp/claude-${uid}`].filter((r, i, a) => fs.existsSync(r) && a.indexOf(r) === i);
}

/**
 * Pure selector. entries: {dir, name, newestMtimeMs}. psText: output of
 * `ps -axo args=` (all running command lines). Returns the entries safe to
 * delete, i.e. stale AND not live AND not the current session.
 */
function selectPrunable(entries, { now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS, psText = '', currentSessionId = '' } = {}) {
  return entries.filter((e) => {
    if (!e || typeof e.dir !== 'string' || typeof e.name !== 'string' || !Number.isFinite(e.newestMtimeMs)) return false;
    if (now - e.newestMtimeMs <= maxAgeMs) return false; // recently touched
    if (currentSessionId && e.name === currentSessionId) return false;
    if (psText.includes(e.dir) || psText.includes(e.name)) return false; // a live process refers to it
    return true;
  });
}

// Newest mtime anywhere under dir (including dir itself). Throws on error so
// the caller keeps the dir when it cannot be sure.
function newestMtime(dir) {
  let newest = fs.lstatSync(dir).mtimeMs;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      const st = fs.lstatSync(p);
      if (st.mtimeMs > newest) newest = st.mtimeMs;
      if (ent.isDirectory()) stack.push(p);
    }
  }
  return newest;
}

function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else try { total += fs.lstatSync(p).size; } catch { /* vanished */ }
    }
  }
  return total;
}

function readPs() {
  // null on failure: with no liveness data we must not delete anything.
  try {
    return execFileSync('ps', ['-axo', 'args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

function pruneScratchpads({
  roots = defaultRoots(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  now = Date.now(),
  psText = readPs(),
  currentSessionId = process.env.CLAUDE_CODE_SESSION_ID || '',
} = {}) {
  const result = { roots, deleted: [], bytesFreed: 0, errors: [] };
  if (psText === null) {
    result.errors.push('ps failed: no liveness data, nothing deleted');
    return result;
  }
  const entries = [];
  for (const root of roots) {
    let projects;
    try { projects = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const proj of projects) {
      if (!proj.isDirectory()) continue;
      const projDir = path.join(root, proj.name);
      let sessions;
      try { sessions = fs.readdirSync(projDir, { withFileTypes: true }); } catch (e) { result.errors.push(`read ${projDir}: ${e.message}`); continue; }
      for (const s of sessions) {
        if (!s.isDirectory()) continue;
        const dir = path.join(projDir, s.name);
        try {
          entries.push({ dir, name: s.name, newestMtimeMs: newestMtime(dir) });
        } catch (e) {
          result.errors.push(`stat ${dir}: ${e.message}`); // unknown age: keep
        }
      }
    }
  }
  for (const e of selectPrunable(entries, { now, maxAgeMs, psText, currentSessionId })) {
    try {
      const size = dirSize(e.dir);
      // Re-check right before deleting: a session may have written meanwhile.
      if (newestMtime(e.dir) !== e.newestMtimeMs) {
        result.errors.push(`skip ${e.dir}: changed since scan`);
        continue;
      }
      fs.rmSync(e.dir, { recursive: true, force: true });
      result.deleted.push(e.dir);
      result.bytesFreed += size;
    } catch (err) {
      result.errors.push(`delete ${e.dir}: ${err.message}`);
    }
  }
  return result;
}

/** Session-start wrapper: only prunes if the cooldown claim is won. */
function pruneScratchpadsIfDue({ markerPath = DEFAULT_MARKER_PATH, cooldownMs = DEFAULT_COOLDOWN_MS, now = Date.now(), ...opts } = {}) {
  if (!pruneDue({ markerPath, cooldownMs, now })) return null;
  return pruneScratchpads({ ...opts, now });
}

module.exports = {
  DEFAULT_MAX_AGE_MS,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_MARKER_PATH,
  selectPrunable,
  newestMtime,
  pruneScratchpads,
  pruneScratchpadsIfDue,
};
