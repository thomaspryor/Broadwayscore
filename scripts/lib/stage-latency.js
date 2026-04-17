'use strict';

const fs = require('fs');
const path = require('path');

/** @typedef {'review-first-seen'|'review-text-collected'|'scored'|'rebuilt'|'deployed-live'} Stage */

const DEFAULT_LOG = path.join(__dirname, '../../data/audit/stage-latency.jsonl');

/**
 * Append one structured JSONL line to the stage-latency log.
 * Safe for concurrent writers — one atomic append per call.
 *
 * @param {object} opts
 * @param {string}  opts.showId
 * @param {string}  [opts.reviewKey]   "{outletId}:{critic}:{url}" stable dedup key
 * @param {Stage}   opts.stage
 * @param {string}  [opts.at]          ISO-8601; defaults to now
 * @param {object}  [opts.metadata]    free-form extras (runId, sha, reviewCount, …)
 */
function emitStage({ showId, reviewKey, stage, at, metadata }) {
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
    fs.appendFileSync(logFile, line + '\n', { encoding: 'utf8', flag: 'a' });
  } catch (err) {
    // Never block the production pipeline — log to stderr and continue
    process.stderr.write(`[stage-latency] write failed: ${err.message}\n`);
  }
}

module.exports = { emitStage };
