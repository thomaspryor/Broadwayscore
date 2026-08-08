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

// How far back a review-level event keeps its show "tracked". Must comfortably
// exceed the SLA's evaluation horizon (two opening weekends ≈ 14 days) so a
// show whose review is still in flight never drops out of the set while the
// SLA is still watching it.
const TRACKED_WINDOW_DAYS = 21;

// Only the tail of the log is scanned. A review-level event older than the
// window cannot make a show tracked, and reading 40 MB on every rebuild to
// learn that would be pure waste.
const TRACKED_SCAN_BYTES = 8 * 1024 * 1024;

const REVIEW_LEVEL_STAGES = new Set(['review-first-seen', 'review-text-collected', 'scored']);

/**
 * Show IDs with a review-level stage event in the recent window — i.e. the
 * shows the opening-night SLA could currently be watching.
 *
 * rebuild-all-reviews uses this to decide which shows get a per-show 'rebuilt'
 * terminal. Emitting one for all ~1,210 shows with reviews was 99.87% of the
 * log and rotated the review history away every ~3.5 days (task #388); emitting
 * one for NO show would silently clear nothing and page everything. Scoping to
 * tracked shows keeps the terminal exactly as informative as before for every
 * show that can have an in-flight review, at ~5% of the volume.
 *
 * @param {object} [opts]
 * @param {string} [opts.logFile]
 * @param {Date}   [opts.now]
 * @param {number} [opts.days=21]
 * @returns {Set<string>}
 */
function readTrackedShowIds({ logFile, now = new Date(), days = TRACKED_WINDOW_DAYS, scanBytes = TRACKED_SCAN_BYTES } = {}) {
  const file = logFile || process.env.STAGE_LATENCY_LOG || DEFAULT_LOG;
  const out = new Set();
  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    return out; // no log yet — nothing is tracked
  }

  let text;
  try {
    const start = Math.max(0, size - scanBytes);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(Math.min(scanBytes, size));
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    // Drop a partial first line when we started mid-file.
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
  } catch (err) {
    process.stderr.write(`[stage-latency] tracked-show scan failed: ${err.message}\n`);
    return out;
  }

  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  for (const line of text.split('\n')) {
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || !e.showId || !e.at) continue;
    if (!REVIEW_LEVEL_STAGES.has(e.stage)) continue;
    if (e.at < cutoff) continue;
    out.add(e.showId);
  }
  return out;
}

module.exports = {
  emitStage,
  rotateIfNeeded,
  readTrackedShowIds,
  MAX_LOG_BYTES,
  RETAIN_BYTES,
  TRACKED_WINDOW_DAYS,
  REVIEW_LEVEL_STAGES,
};
