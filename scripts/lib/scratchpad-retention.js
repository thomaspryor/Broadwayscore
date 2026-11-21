/**
 * scratchpad-retention — bounded pruning for Claude Code scratchpad dirs
 * (/private/tmp/claude-<uid>/<project>/<session-id>/, BRO-2572, cousin of
 * BRO-2258's job-log-retention). One session dir is added per session and
 * nothing removed them, so /private/tmp grew until the disk filled.
 *
 * Unlike job logs, a scratchpad can belong to a session that is running right
 * now but idle (long review, paused mid-task), so age alone is never enough.
 * A session dir is deleted only when ALL hold:
 *   1. its name is a session UUID (harness dirs such as bash-edit-diff/<hash>
 *      at the same depth are never touched);
 *   2. its newest file/dir mtime (whole tree) is older than maxAgeMs;
 *   3. it is not the current session (CLAUDE_CODE_SESSION_ID);
 *   4. no live Claude Code process owns it. The real signal is Claude Code's
 *      session registry, ~/.claude/sessions/<pid>.json ({pid, sessionId}):
 *      a row whose pid is alive keeps its sessionId's dir. A claude process's
 *      command line does NOT carry its session id (`claude --preload ...`),
 *      so the ps text is only a second signal (--resume <id>, a tool running
 *      from inside the dir) (BRO-5261 retro-review).
 * Any doubt (stat error, ps failure, unreadable registry) keeps the dir.
 * Fail-open for the hook: nothing here throws, and a missing root is a no-op.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { pruneDue } = require('./job-log-retention.js');
const { MAIN_REPO_ROOT } = require('./repo-root');

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h idle
const DEFAULT_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h between prunes
// Main repo root, not __dirname: one cooldown per machine, not one per
// worktree (every new job worktree would otherwise win its first claim).
const DEFAULT_MARKER_PATH = path.join(MAIN_REPO_ROOT, 'data', 'audit', 'scratchpad-prune.lock');
const DEFAULT_REGISTRY_DIR = path.join(process.env.HOME || '', '.claude', 'sessions');
const SESSION_DIR_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function defaultRoots() {
  const uid = typeof process.getuid === 'function' ? process.getuid() : '';
  const seen = new Set();
  const roots = [];
  for (const r of [`/private/tmp/claude-${uid}`, `/tmp/claude-${uid}`]) {
    let real;
    try { real = fs.realpathSync(r); } catch { continue; } // absent
    if (seen.has(real)) continue; // macOS: /tmp -> /private/tmp
    seen.add(real);
    roots.push(real);
  }
  return roots;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/**
 * Session ids of live Claude Code processes, from the session registry.
 * Returns null when the registry cannot be read: with no liveness data the
 * caller must not delete anything.
 */
function readLiveSessionIds({ registryDir = DEFAULT_REGISTRY_DIR, isAlive = pidAlive } = {}) {
  let names;
  try { names = fs.readdirSync(registryDir); } catch { return null; }
  const ids = new Set();
  for (const n of names) {
    if (!n.endsWith('.json')) continue; // the same dir holds <pid>.<hash>.key files
    try {
      const row = JSON.parse(fs.readFileSync(path.join(registryDir, n), 'utf8'));
      if (row && typeof row.sessionId === 'string' && isAlive(row.pid)) ids.add(row.sessionId.toLowerCase());
    } catch { /* torn or foreign file: skip it */ }
  }
  return ids;
}

/**
 * Pure selector. entries: {dir, name, newestMtimeMs}. psText: output of
 * `ps -axo args=`. liveIds: Set of live session ids (registry). Returns the
 * entries safe to delete.
 */
function selectPrunable(entries, { now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS, psText = '', currentSessionId = '', liveIds = new Set() } = {}) {
  return entries.filter((e) => {
    if (!e || typeof e.dir !== 'string' || typeof e.name !== 'string' || !Number.isFinite(e.newestMtimeMs)) return false;
    if (!SESSION_DIR_RE.test(e.name)) return false; // not a session dir
    if (now - e.newestMtimeMs <= maxAgeMs) return false; // recently touched
    if (currentSessionId && e.name.toLowerCase() === currentSessionId.toLowerCase()) return false;
    if (liveIds.has(e.name.toLowerCase())) return false; // a live session owns it
    if (psText.includes(e.dir) || psText.includes(e.name)) return false; // a live process refers to it
    return true;
  });
}

// Newest mtime anywhere under dir (including dir itself). Stops early once an
// mtime above stopAboveMs is seen (the dir is fresh; the exact value is moot).
// Throws on error so the caller keeps the dir when it cannot be sure.
function newestMtime(dir, stopAboveMs = Infinity) {
  let newest = fs.lstatSync(dir).mtimeMs;
  const stack = [dir];
  while (stack.length && newest <= stopAboveMs) {
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
    return execFileSync('ps', ['-axo', 'args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 10_000 });
  } catch {
    return null;
  }
}

function pruneScratchpads({
  roots = defaultRoots(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  now = Date.now(),
  psText = readPs(),
  liveIds = readLiveSessionIds(),
  currentSessionId = process.env.CLAUDE_CODE_SESSION_ID || '',
} = {}) {
  const result = { roots, deleted: [], bytesFreed: 0, errors: [] };
  if (psText === null) {
    result.errors.push('ps failed: no liveness data, nothing deleted');
    return result;
  }
  if (liveIds === null) {
    result.errors.push(`session registry ${DEFAULT_REGISTRY_DIR} unreadable: no liveness data, nothing deleted`);
    return result;
  }
  const cutoff = now - maxAgeMs;
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
        if (!s.isDirectory() || !SESSION_DIR_RE.test(s.name)) continue;
        const dir = path.join(projDir, s.name);
        try {
          entries.push({ dir, name: s.name, newestMtimeMs: newestMtime(dir, cutoff) });
        } catch (e) {
          result.errors.push(`stat ${dir}: ${e.message}`); // unknown age: keep
        }
      }
    }
  }
  for (const e of selectPrunable(entries, { now, maxAgeMs, psText, currentSessionId, liveIds })) {
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

/** One or two hook lines for a prune result ('' when there is nothing to say). */
function formatPruneResult(r) {
  if (!r) return '';
  const out = [];
  if (r.deleted.length > 0) out.push(`🔶 SCRATCHPAD RETENTION: pruned ${r.deleted.length} idle session dir(s) (freed ~${(r.bytesFreed / 1024 / 1024).toFixed(1)}MB).`);
  if (r.errors.length > 0) out.push(`🔶 SCRATCHPAD RETENTION: ${r.errors.length} issue(s) — first: ${r.errors[0]}`);
  return out.join('\n');
}

module.exports = {
  DEFAULT_MAX_AGE_MS,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_MARKER_PATH,
  SESSION_DIR_RE,
  defaultRoots,
  readLiveSessionIds,
  selectPrunable,
  newestMtime,
  pruneScratchpads,
  pruneScratchpadsIfDue,
  formatPruneResult,
};
