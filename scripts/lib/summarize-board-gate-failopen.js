'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

/** Summarize the previous UTC calendar day, independent of the Mac's timezone. */
function summarizeBoardGateFailopen(log, { now = new Date() } = {}) {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const start = end - 24 * 60 * 60 * 1000;
  const counts = { unreachable: 0, erroring: 0, broken: 0 };
  for (const line of log.split(/\r?\n/)) {
    const timestamp = line.trim().split(/\s+/, 1)[0];
    // Require a timezone so a malformed/local timestamp cannot shift the day.
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp)) continue;
    const at = Date.parse(timestamp);
    if (!(at >= start && at < end)) continue;
    const verdict = line.match(/\sverdict=(unreachable|erroring|broken)(?=\s|$)/)?.[1];
    if (verdict) counts[verdict]++;
  }
  const failedOpen = counts.unreachable + counts.erroring;
  if (!failedOpen && !counts.broken) return null;

  // This log contains failures only. A share-of-all-commits threshold would
  // need a healthy-commit denominator from the writer; do not invent one.
  return {
    counts,
    failedOpen,
    line: `board gate: ${failedOpen} failed open (${counts.unreachable} unreachable, ${counts.erroring} erroring), ${counts.broken} broken`,
    alert: counts.broken
      ? 'Board gate is non-functional: its probe is broken. File a repair card.'
      : null,
  };
}

function readBoardGateFailopen({
  logPath = process.env.BOARD_GATE_FAILOPEN_LOG || path.join(os.homedir(), '.claude', 'logs', 'board-gate-failopen.log'),
  now = new Date(),
} = {}) {
  let log;
  try {
    log = fs.readFileSync(logPath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[digest] WARN could not read board gate log: ${err.code}`);
    return null;
  }
  return summarizeBoardGateFailopen(log, { now });
}

module.exports = { summarizeBoardGateFailopen, readBoardGateFailopen };
