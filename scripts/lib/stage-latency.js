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

// Scan every byte rotation retains. An earlier draft scanned only the newest
// 8 MB, which is a silent starvation bug: rotation keeps 20 MB, so a
// review-level event sitting in retained bytes 8–20 MB is inside the 21-day
// window but invisible to the scan. Its show would drop out of the tracked
// set, stop receiving 'rebuilt' terminals, and its already-delivered review
// would start paging as stuck with nothing to re-add it. Reading what is
// retained costs at most one 20 MB read per rebuild, and after this change the
// log holds ~200 lines/day, so in steady state it is a few hundred KB.
const TRACKED_SCAN_BYTES = RETAIN_BYTES;

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

  let text;
  let truncated = false;
  try {
    // Open FIRST, then fstat the open descriptor. Sizing from a separate
    // statSync(path) races rotateIfNeeded(), which replaces the file via
    // tmp+rename: a 40 MB stat followed by a read of the renamed-in 20 MB file
    // would seek past EOF, return a zero-filled buffer, and yield an EMPTY
    // tracked set — i.e. every show silently loses its 'rebuilt' terminal for
    // that run. fstat binds the size to the same inode we go on to read.
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - scanBytes);
      const want = Math.min(scanBytes, size);
      const buf = Buffer.alloc(want);
      // Honour the ACTUAL byte count — a short read must not be padded with
      // NUL bytes and parsed as if it were log content.
      const bytesRead = fs.readSync(fd, buf, 0, want, start);
      text = buf.subarray(0, bytesRead).toString('utf8');
      // Drop a partial first line when we started mid-file.
      if (start > 0) {
        truncated = true;
        const nl = text.indexOf('\n');
        text = nl === -1 ? '' : text.slice(nl + 1);
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    // ENOENT (no log yet) is normal on a fresh checkout — nothing is tracked.
    if (err && err.code !== 'ENOENT') {
      process.stderr.write(`[stage-latency] tracked-show scan failed: ${err.message}\n`);
    }
    return out;
  }

  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
  let oldestSeen = null;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!e || !e.at) continue;
    if (!oldestSeen || e.at < oldestSeen) oldestSeen = e.at;
    if (!e.showId) continue;
    if (!REVIEW_LEVEL_STAGES.has(e.stage)) continue;
    if (e.at < cutoff) continue;
    out.add(e.showId);
  }

  // Say so when the scan could not actually see the whole window. If the
  // oldest line we read is NEWER than the cutoff, older events exist that we
  // never looked at, so a show could be silently missing from the set — which
  // costs it its 'rebuilt' terminal and makes its delivered review page as
  // stuck. Better a loud line in the rebuild log than a monitor that quietly
  // narrows and nobody notices (the vacuous-gate class).
  if (truncated && oldestSeen && oldestSeen > cutoff) {
    process.stderr.write(
      `[stage-latency] WARNING: tracked-show scan covered only back to ${oldestSeen}, `
      + `but the ${days}-day window starts at ${cutoff}. Shows whose only recent activity `
      + `predates the scanned region will not receive a 'rebuilt' terminal this run.\n`
    );
  }
  return out;
}

/**
 * Which shows get a per-show 'rebuilt' terminal this run.
 *
 * Extracted from rebuild-all-reviews.js so the decision is testable (CLAUDE.md
 * rule 15) — inline, an inverted condition or a deleted guard here would ship
 * with zero test failure while either flooding the log again or, worse,
 * emitting terminals for nobody and paging every in-flight review.
 *
 * @param {string[]|Iterable<string>} showIdsWithReviews shows present in reviews.json
 * @param {Set<string>} trackedShowIds from readTrackedShowIds()
 * @returns {string[]} intersection, in input order
 */
function selectTerminalShowIds(showIdsWithReviews, trackedShowIds) {
  const tracked = trackedShowIds instanceof Set ? trackedShowIds : new Set(trackedShowIds || []);
  const out = [];
  for (const showId of showIdsWithReviews || []) {
    if (tracked.has(showId)) out.push(showId);
  }
  return out;
}

module.exports = {
  emitStage,
  rotateIfNeeded,
  readTrackedShowIds,
  selectTerminalShowIds,
  MAX_LOG_BYTES,
  RETAIN_BYTES,
  TRACKED_WINDOW_DAYS,
  REVIEW_LEVEL_STAGES,
};
