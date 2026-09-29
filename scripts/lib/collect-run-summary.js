'use strict';

/**
 * BRO-4273: a small marker collect-review-texts.js writes right after its
 * final checkpoint push, read back by opening-night-pipeline-verify.js.
 *
 * Why a file and not a step output: the failure this exists for is a collect
 * step that finished its work, pushed, and then got killed by the step's
 * timeout-minutes because node would not exit. A file written before the
 * kill survives it; the verify step (a later step in the same job) reads it
 * no matter how the collect step ended.
 *
 * Opt-in: nothing is written unless COLLECT_SUMMARY_FILE is set, so other
 * callers of the collector (bulk/backfill workflows, local runs) are
 * unaffected.
 */

const fs = require('fs');

function buildCollectSummary({ processed = 0, failed = 0, timedOut = [] } = {}) {
  return {
    finished: true,
    processed,
    failed,
    timedOut: timedOut.length,
    timedOutUrls: timedOut.map((r) => r.url || r.reviewId).filter(Boolean),
    finishedAt: new Date().toISOString(),
  };
}

function writeCollectSummary(filePath, summary) {
  if (!filePath) return false;
  fs.writeFileSync(filePath, JSON.stringify(summary, null, 2) + '\n');
  return true;
}

// Never throws: a missing or unreadable marker means "did not finish".
function readCollectSummary(filePath) {
  const none = { finished: false, timedOut: 0 };
  if (!filePath) return none;
  try {
    const s = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!s || s.finished !== true) return none;
    return { finished: true, timedOut: Number.isInteger(s.timedOut) && s.timedOut > 0 ? s.timedOut : 0 };
  } catch {
    return none;
  }
}

module.exports = { buildCollectSummary, writeCollectSummary, readCollectSummary };
