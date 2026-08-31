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
 * pruneJobLogsIfDue() adds a cooldown so ~20 concurrent cmux sessions each
 * firing session-start.sh don't all redo the same readdir+stat(N)+unlink
 * work on every hook fire — one prune per cooldown window. The claim is an
 * atomic `mkdir` (bsc-runner.js's lease pattern, acquireLease ~line 74: a
 * plain check-then-write file-mtime check is NOT atomic across processes —
 * two sessions can both observe "not on cooldown" and both proceed; `mkdir`
 * fails EEXIST for every loser, so only one session per window ever prunes
 * (ship-check finding, BRO-2258 review). pruneJobLogs() itself stays
 * cooldown-free and pure for direct unit testing.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { LOG_ROOT, REPO } = require('./bsc-runner.js');

const DEFAULT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_MARKER_PATH = path.join(REPO, 'data', 'audit', 'job-log-prune.lock');

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
    const filePath = path.join(dir, entry.name);
    try {
      // Re-stat immediately before unlink and require an exact match against
      // the mtime recorded above — closes the TOCTOU window where a
      // concurrent pruner (or a genuinely new job reusing a recycled name,
      // vanishingly unlikely since bsc-runner job ids are unique but cheap
      // to guard against anyway) replaces the file between the scan and the
      // delete (ship-check finding, BRO-2258 review).
      const recheck = fs.statSync(filePath);
      if (recheck.mtimeMs !== entry.mtimeMs) {
        result.errors.push(`skip ${entry.name}: mtime changed since scan, not deleting`);
        continue;
      }
      fs.unlinkSync(filePath);
      result.deleted.push(entry.name);
      result.bytesFreed += entry.size;
    } catch (e) {
      result.errors.push(`unlink ${entry.name}: ${e.message}`);
    }
  }
  return result;
}

/**
 * Cooldown claim — true at most once per cooldownMs across all callers,
 * regardless of process. `mkdir` on lockDir is the atomic part (EEXIST for
 * every loser, bsc-runner.js's acquireLease pattern ~line 74) — a plain
 * stat-then-write check (this function's first cut, since fixed) is NOT
 * atomic: two sessions can both observe "not on cooldown" in the gap before
 * either writes, and both proceed to prune concurrently. The lock dir is
 * left in place after a successful claim (never rmdir'd) so its mtime IS
 * the cooldown timestamp for the next fire — the loser path re-checks that
 * mtime and reclaims (rmdir + mkdir) only once it's actually stale, which
 * narrows the race to the rare instant a cooldown window rolls over, not
 * every single hook fire. Fail-open: an unexpected fs error just skips this
 * fire (returns false) rather than throwing.
 */
function pruneDue({ markerPath = DEFAULT_MARKER_PATH, cooldownMs = DEFAULT_COOLDOWN_MS, now = Date.now() } = {}) {
  try {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.mkdirSync(markerPath);
    return true; // no lock existed at all — first-ever claim
  } catch (e) {
    if (e.code !== 'EEXIST') return false; // unexpected fs error — skip this fire
  }
  // Someone (possibly an earlier run of this same process, e.g. a prior
  // session) already holds/held the claim. Stale means the window elapsed —
  // reclaim it for this fire.
  let stat;
  try {
    stat = fs.statSync(markerPath);
  } catch {
    return false; // lock vanished between mkdir/EEXIST and stat — skip, next fire retries
  }
  if (now - stat.mtimeMs < cooldownMs) return false; // genuinely on cooldown
  try {
    fs.rmSync(markerPath, { recursive: true, force: true });
    fs.mkdirSync(markerPath);
    return true;
  } catch {
    return false; // lost the reclaim race (or fs error) — next fire retries
  }
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
