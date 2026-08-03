/**
 * Merge-aware checkpoint I/O for classify-wrong-show.js / classify-wrong-production.js
 * (task #925, the #893 class).
 *
 * Both scripts hold an in-memory `checkpoint` object keyed by `showId/file`
 * and, every batch, wrote the WHOLE object over CHECKPOINT_PATH with a plain
 * unlocked fs.writeFileSync.
 *
 * The race this actually guards against is LOCAL, not cross-CI-runner: both
 * `.classify-ws-checkpoint.json` and `.classify-wp-checkpoint.json` are
 * untracked scratch files (never committed — confirmed via `git ls-files` and
 * `git log --all`, and absent from push-core-data's CORE_FILES list), so two
 * separate GitHub Actions runs never actually share this file — each runner
 * gets a fresh, empty one. The real exposure is this Mac Studio's shared main
 * checkout: a manual terminal run, a launchd job, or a second Claude Code
 * session invoking either classify script against the SAME on-disk checkpoint
 * path at the same time (the same "local terminal run overlapping a cron run"
 * pattern gap-audit-merge.js's docstring calls out for its own file). Two such
 * runs hold DIFFERENT sets of freshly-classified keys; the later writer's
 * whole-object write erases the earlier run's. Lost keys just mean those
 * reviews get reclassified next run (wasted LLM spend), not a scoring-
 * correctness bug — so, unlike gap-audit-merge.js's per-show verdict/retention
 * logic, a checkpoint entry here is a flat, immutable-once-written value and a
 * lock + read-merge-write is the whole fix. "Immutable once written" holds
 * because findCandidates() (in both callers) permanently excludes any review
 * file already carrying a classification flag — a key can't re-enter a run's
 * in-memory `checkpoint` with a different verdict once applied. A future
 * caller reusing this helper for a checkpoint WITHOUT that same exclusion
 * invariant would need to reconsider the "local wins" merge rule below.
 *
 * Reuses withFileLock from gap-audit-merge.js (task #902) rather than
 * reimplementing lock semantics.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { withFileLock } = require('./gap-audit-merge');

/**
 * Write-then-rename so a reader (including the pre-existing, unlocked
 * `--resume` startup load in both classify scripts) never observes a torn
 * file — mirrors audit-show-review-gap.js's writeJsonAtomic.
 */
function writeJsonAtomic(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
}

/** Read the checkpoint file, distinguishing "doesn't exist yet" (expected,
 * start empty) from "exists but failed to parse" (suspicious — warn, since
 * silently discarding an existing file's content is exactly the #893 shape). */
function readCheckpointOrWarn(checkpointPath) {
  try {
    return JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.error(`::warning::classify-checkpoint: ${checkpointPath} exists but failed to parse (${e.message}) — treating as empty. If this wasn't expected (e.g. not a fresh/never-written file), investigate before trusting the result.`);
    }
    return {};
  }
}

/**
 * Merge `localCheckpoint` (this run's full in-memory view — whatever it
 * loaded via --resume plus every key it classified this run) into whatever is
 * currently on disk, and persist the merged result.
 *
 * On conflict (same key written by two runs) `localCheckpoint` wins, since it
 * reflects this run's own freshly-computed verdict for that key.
 *
 * @param {string} checkpointPath
 * @param {Object} localCheckpoint
 * @returns {Object} the merged object actually persisted to disk
 */
function mergeWriteCheckpoint(checkpointPath, localCheckpoint) {
  return withFileLock(`${checkpointPath}.lock`, (held) => {
    if (!held) {
      console.error(`::warning::classify-checkpoint lock could not be acquired for ${checkpointPath} (assumed stale and broken, or lock dir unwritable) — the read-modify-write ran unprotected. A concurrent run could have lost data.`);
    }
    const onDisk = readCheckpointOrWarn(checkpointPath);
    const merged = { ...onDisk, ...localCheckpoint };
    writeJsonAtomic(checkpointPath, merged);
    return merged;
  });
}

/**
 * Delete the checkpoint file once this run believes it has caught up — but
 * only if nothing on disk is unknown to, or has a fresher value than,
 * `knownCheckpoint`. A concurrent run may have merge-written keys (or updated
 * an existing key's verdict) since our last mergeWriteCheckpoint call;
 * blindly unlinking would destroy that run's progress the exact same way the
 * old whole-object write did. Value comparison, not just key presence — a
 * resumed run's stale local copy of a key must not mask a fresher on-disk
 * verdict for that same key.
 *
 * If the lock can't be acquired, refuse to delete rather than fail open —
 * unlike a mergeable write, a delete is destructive and unrecoverable.
 *
 * @param {string} checkpointPath
 * @param {Object} knownCheckpoint  every key this run has ever seen (its own + anything merged in)
 * @returns {boolean} true if the file was deleted
 */
function deleteCheckpointIfCaughtUp(checkpointPath, knownCheckpoint) {
  return withFileLock(`${checkpointPath}.lock`, (held) => {
    if (!held) {
      console.error(`::warning::classify-checkpoint lock could not be acquired for cleanup of ${checkpointPath} — skipping delete rather than racing a concurrent writer.`);
      return false;
    }
    let onDisk;
    try {
      onDisk = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
    } catch {
      return false; // already gone / unreadable — nothing to clean up
    }
    const staleOrUnknown = Object.keys(onDisk).some((k) => {
      if (!(k in knownCheckpoint)) return true; // a concurrent run added a key we don't know about
      return JSON.stringify(onDisk[k]) !== JSON.stringify(knownCheckpoint[k]); // known key, but disk has a fresher value
    });
    if (staleOrUnknown) return false;
    fs.unlinkSync(checkpointPath);
    return true;
  });
}

module.exports = { mergeWriteCheckpoint, deleteCheckpointIfCaughtUp };
