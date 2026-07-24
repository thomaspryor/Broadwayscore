'use strict';

const fs = require('fs');
const path = require('path');

/** @typedef {'review-first-seen'|'review-text-collected'|'scored'|'rebuilt'|'deployed-live'} Stage */

const DEFAULT_LOG = path.join(__dirname, '../../data/audit/stage-latency.jsonl');

// Rotation: the log is append-only and committed to git, so unbounded growth
// eventually hits GitHub's 100 MiB push limit (2026-07-05: 100.15MB broke
// every data-committing workflow for a day). When the file crosses
// MAX_LOG_BYTES, drop the oldest lines and keep the newest RETAIN_BYTES.
// SLA/latency consumers only need recent days; history is preserved in the
// daily data/audit/opening-night-latency-*.json snapshots.
const MAX_LOG_BYTES = 40 * 1024 * 1024;
const RETAIN_BYTES = 20 * 1024 * 1024;

/**
 * Trim logFile to its newest retainBytes, aligned to a line boundary.
 * Rewrites atomically (tmp + rename) so concurrent readers never see a
 * partial file. A concurrent append between read and rename can lose that
 * one line — acceptable for an audit log, and rotation is rare.
 *
 * @returns {boolean} true if the file was rotated
 */
function rotateIfNeeded(logFile, maxBytes = MAX_LOG_BYTES, retainBytes = RETAIN_BYTES) {
  let size;
  try {
    size = fs.statSync(logFile).size;
  } catch {
    return false; // no file yet
  }
  if (size <= maxBytes) return false;

  const fd = fs.openSync(logFile, 'r');
  let chunk;
  try {
    const start = Math.max(0, size - retainBytes);
    chunk = Buffer.alloc(Math.min(retainBytes, size));
    fs.readSync(fd, chunk, 0, chunk.length, start);
  } finally {
    fs.closeSync(fd);
  }
  // Start at the first complete line
  const nl = chunk.indexOf(0x0a);
  const trimmed = chunk.subarray(nl + 1);
  const tmp = `${logFile}.rotate-tmp-${process.pid}`;
  fs.writeFileSync(tmp, trimmed);
  fs.renameSync(tmp, logFile);
  process.stderr.write(
    `[stage-latency] rotated log: ${size} -> ${trimmed.length} bytes (kept newest lines)\n`
  );
  return true;
}

/**
 * Append one structured JSONL line to the stage-latency log.
 * Safe for concurrent writers — one atomic append per call.
 * Rotates the log first when it exceeds MAX_LOG_BYTES.
 *
 * @param {object} opts
 * @param {string}  opts.showId
 * @param {string}  [opts.reviewKey]   "{outletId}:{critic}:{url}" stable dedup key
 * @param {Stage}   opts.stage
 * @param {string}  [opts.at]          ISO-8601; defaults to now
 * @param {object}  [opts.metadata]    free-form extras (runId, sha, reviewCount, …)
 */
function emitStage({ showId, reviewKey, stage, at, metadata }) {
  // Prevention (2026-07-24): CI unit tests exercise review-file-writer, whose
  // saveReview emits review-first-seen unconditionally. Without STAGE_LATENCY_LOG
  // pointed at a temp file those fixture rows (guard-*, test-show-2026, fake URLs)
  // landed in the committed prod log and the opening-night SLA counted them as
  // "stuck ≥60 min". BSC_STAGE_LATENCY_MUTE=1 (set in test.yml's unit step) makes
  // the emit a no-op UNLESS a test explicitly points STAGE_LATENCY_LOG at its own
  // file — so stage-latency's own tests still work.
  if (process.env.BSC_STAGE_LATENCY_MUTE === '1' && !process.env.STAGE_LATENCY_LOG) return;

  const logFile = process.env.STAGE_LATENCY_LOG || DEFAULT_LOG;

  const line = JSON.stringify({
    showId,
    reviewKey: reviewKey || null,
    stage,
    at: at || new Date().toISOString(),
    ...(metadata ? { metadata } : {}),
  });

  try {
    const dir = path.dirname(logFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    rotateIfNeeded(logFile);
    fs.appendFileSync(logFile, line + '\n', { encoding: 'utf8', flag: 'a' });
  } catch (err) {
    // Never block the production pipeline — log to stderr and continue
    process.stderr.write(`[stage-latency] write failed: ${err.message}\n`);
  }
}

module.exports = { emitStage, rotateIfNeeded, MAX_LOG_BYTES, RETAIN_BYTES };
