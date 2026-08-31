/**
 * job-log-retention — bounded pruning for ~/Library/Logs/bsc-jobs (BRO-2258).
 *
 * Nothing pruned this directory before this landed: at ~40 headless jobs/day
 * and 1-2MB/log it grows unbounded — a self-inflicted disk-fill on a timer,
 * exactly the failure mode that silently broke cmux runtime spawning and
 * headless job logging on 2026-08-30 (117Mi free out of 460Gi, ENOSPC on
 * every write). Retention is generous (14 days by default) — job logs are a
 * debugging aid for recent jobs, not an archive.
 *
 * pruneJobLogsIfDue() adds a file-mtime cooldown (same shape as
 * bsc-runner.js's diskPressureAlertDue, ~line 187) so ~20 concurrent cmux
 * sessions each firing session-start.sh don't all redo the same
 * readdir+stat(N)+unlink work on every hook fire — one prune per cooldown
 * window, whichever session gets there first (second-opinion review finding,
 * BRO-2258 plan review). pruneJobLogs() itself stays cooldown-free and pure
 * for direct unit testing.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { LOG_ROOT, REPO } = require('./bsc-runner.js');

const DEFAULT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_MARKER_PATH = path.join(REPO, 'data', 'audit', 'job-log-prune-last-run.json');

/**
 * Pure selector: given entries of {name, mtimeMs}, returns the names older
 * than maxAgeMs relative to now. Testable without touching the filesystem.
 */
function selectStaleLogNames(entries, { now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
  return entries
    .filter((e) => e && typeof e.name === 'string' && Number.isFinite(e.mtimeMs))
    .filter((e) => now - e.mtimeMs > maxAgeMs)
    .map((e) => e.name);
}

/**
 * Prunes *.log files older than maxAgeMs from dir. Fail-open: a missing dir
 * (fresh machine, cloud sandbox) or a per-file stat/unlink error is silently
 * skipped rather than thrown — this runs on every session start and must
 * never block one.
 */
function pruneJobLogs({ dir = LOG_ROOT, maxAgeMs = DEFAULT_MAX_AGE_MS, now = Date.now() } = {}) {
  const result = { dir, deleted: [], bytesFreed: 0, errors: [] };
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return result; // dir doesn't exist yet — nothing to prune
  }

  const entries = [];
  for (const name of names) {
    if (!name.endsWith('.log')) continue;
    try {
      const st = fs.statSync(path.join(dir, name));
      entries.push({ name, mtimeMs: st.mtimeMs, size: st.size });
    } catch (e) {
      result.errors.push(`stat ${name}: ${e.message}`);
    }
  }

  const staleNames = new Set(selectStaleLogNames(entries, { now, maxAgeMs }));
  for (const entry of entries) {
    if (!staleNames.has(entry.name)) continue;
    try {
      fs.unlinkSync(path.join(dir, entry.name));
      result.deleted.push(entry.name);
      result.bytesFreed += entry.size;
    } catch (e) {
      result.errors.push(`unlink ${entry.name}: ${e.message}`);
    }
  }
  return result;
}

/**
 * Cooldown check (and claim) — true at most once per cooldownMs across all
 * callers, regardless of process. Mirrors bsc-runner.js's
 * diskPressureAlertDue: file-mtime based (not in-memory), since callers are
 * separate processes (separate cmux sessions) that share nothing else.
 * Fail-open: a marker-write failure just means the next fire re-checks.
 */
function pruneDue({ markerPath = DEFAULT_MARKER_PATH, cooldownMs = DEFAULT_COOLDOWN_MS, now = Date.now() } = {}) {
  try {
    const stat = fs.statSync(markerPath);
    if (now - stat.mtimeMs < cooldownMs) return false;
  } catch { /* no marker yet — due */ }
  try {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, JSON.stringify({ ts: new Date(now).toISOString() }));
  } catch { /* best-effort; next fire just re-checks */ }
  return true;
}

/** Convenience wrapper for the session-start hook: only prunes if due. */
function pruneJobLogsIfDue({ markerPath, cooldownMs, now = Date.now(), ...pruneOpts } = {}) {
  if (!pruneDue({ markerPath, cooldownMs, now })) return null;
  return pruneJobLogs({ ...pruneOpts, now });
}

module.exports = {
  DEFAULT_MAX_AGE_MS,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_MARKER_PATH,
  LOG_ROOT,
  selectStaleLogNames,
  pruneJobLogs,
  pruneDue,
  pruneJobLogsIfDue,
};
