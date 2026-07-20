'use strict';

/**
 * Atomic shows.json write helper.
 *
 * Why this exists: Pre-Mortem secondary scenario — a CI timeout mid-write
 * leaves shows.json half-written; the next run rebases on the truncated
 * file and silently drops 30+ entries (see feedback_silent_merge_loss_on_reformat.md).
 *
 * Strategy:
 *   1. Stringify the new state.
 *   2. Compare line count vs current file. If new count is >5% smaller
 *      AND the caller did NOT pass `allowShrink: true`, abort with an error.
 *   3. Write to <path>.tmp.
 *   4. fs.renameSync(<path>.tmp, <path>) — atomic on POSIX filesystems.
 *
 * Caller is responsible for `git pull --rebase` discipline before/after.
 * This helper only protects against half-write corruption, not concurrent
 * writers (those still race at the shows.json level — see promote script
 * for the file lock).
 */

const fs = require('fs');

class AtomicWriteShrinkError extends Error {
  constructor(currentLines, newLines, dropPct) {
    super(
      `Refusing to write shows.json: would drop ${currentLines - newLines} entries ` +
      `(${dropPct.toFixed(1)}% drop, threshold 5%). ` +
      `Pass {allowShrink: true} to override (e.g. when explicitly deleting shows).`
    );
    this.name = 'AtomicWriteShrinkError';
    this.currentLines = currentLines;
    this.newLines = newLines;
    this.dropPct = dropPct;
  }
}

/**
 * Atomically write a shows.json-shaped object to disk with a line-count
 * shrink-gate.
 *
 * @param {string} targetPath - Absolute path to shows.json (may be a symlink).
 * @param {object} newData - The full shows.json object (e.g. { shows: [...] }).
 * @param {object} options
 * @param {boolean} options.allowShrink - If true, skip the line-count gate.
 * @param {number} options.shrinkThresholdPct - Default 5 (= 5% drop limit).
 * @returns {{lineCountBefore: number, lineCountAfter: number, wrote: boolean}}
 */
function atomicWriteShowsJson(targetPath, newData, options = {}) {
  const allowShrink = !!options.allowShrink;
  const shrinkThresholdPct = options.shrinkThresholdPct ?? 5;

  const newJson = JSON.stringify(newData, null, 2);
  const newLines = newJson.split('\n').length;

  let currentLines = 0;
  try {
    const current = fs.readFileSync(targetPath, 'utf8');
    currentLines = current.split('\n').length;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    // New file — no shrink possible
  }

  if (!allowShrink && currentLines > 0) {
    const dropPct = ((currentLines - newLines) / currentLines) * 100;
    if (dropPct > shrinkThresholdPct) {
      throw new AtomicWriteShrinkError(currentLines, newLines, dropPct);
    }
  }

  // Resolve symlinks first: rename() onto a symlink REPLACES the symlink with
  // a regular file, silently orphaning the real target. Local checkouts have
  // data/shows.json symlinked into the private core-data clone (2026-07-20:
  // a runtime sweep's fixes landed in a stray local file this way).
  let realPath = targetPath;
  try {
    realPath = fs.realpathSync(targetPath);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const tmpPath = `${realPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, newJson);
  fs.renameSync(tmpPath, realPath);

  return { lineCountBefore: currentLines, lineCountAfter: newLines, wrote: true };
}

module.exports = {
  atomicWriteShowsJson,
  AtomicWriteShrinkError,
};
