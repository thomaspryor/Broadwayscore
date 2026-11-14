'use strict';

const fs = require('fs');
const path = require('path');
const { isTestRun } = require('./test-run-guard');

// Under `node --test` (NODE_TEST_CONTEXT is set by the runner, never in a real
// run) the default is a per-process temp dir: tests reach logExclusion through
// review-guards and friends and used to append synthetic rows to the real
// data/audit/exclusions-<date>.jsonl (BRO-2664; caught by test.yml's ledger
// isolation check). An explicit EXCLUSION_LOGGER_AUDIT_DIR always wins.
const AUDIT_DIR = process.env.EXCLUSION_LOGGER_AUDIT_DIR
  || (isTestRun()
    ? path.join(require('os').tmpdir(), `exclusion-logger-test-${process.pid}`)
    : path.join(__dirname, '../../data/audit'));

const MAX_DETAILS_BYTES = 1024;

let auditDirEnsured = false;

function ensureAuditDir() {
  if (auditDirEnsured) return;
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
  auditDirEnsured = true;
}

function getTodayJsonlPath() {
  const today = new Date().toISOString().slice(0, 10);
  return path.join(AUDIT_DIR, `exclusions-${today}.jsonl`);
}

function logExclusion({ script, showId, file, reason, details }) {
  if (!script) throw new Error('logExclusion: missing required field: script');
  if (!showId) throw new Error('logExclusion: missing required field: showId');
  if (!reason) throw new Error('logExclusion: missing required field: reason');
  if (details === undefined || details === null || typeof details !== 'object' || Array.isArray(details)) {
    throw new Error('logExclusion: details must be a plain object (may be {})');
  }

  // BRO-3601: a caller with no per-file identity used to log file:'-' even
  // when the event carried its URL (gather-reviews' skippedBlockedUrl /
  // skippedCrossShowUrl / skippedBwwForeignTitle, outlet-domain-supplement),
  // so exclusion-trend.js's NO_FILE_IDENTITY carve-out could never tell a
  // re-logged known URL from a new one. Fall back to details.url here, once,
  // instead of relying on every call site to remember. Genuinely show-level
  // reasons (skippedUpcomingShows, ...) carry no url and stay '-'.
  const hasFile = file !== undefined && file !== null && file !== '' && file !== '-';
  const detailUrl = typeof details.url === 'string' && details.url ? details.url : null;
  const resolvedFile = hasFile ? file : (detailUrl || '-');

  // Truncate details if serialized size would exceed MAX_DETAILS_BYTES
  let safeDetails = details;
  const detailsStr = JSON.stringify(details);
  if (detailsStr.length > MAX_DETAILS_BYTES) {
    safeDetails = { ...details };
    // Truncate any string values that are large
    for (const key of Object.keys(safeDetails)) {
      if (typeof safeDetails[key] === 'string' && safeDetails[key].length > 200) {
        safeDetails[key] = safeDetails[key].slice(0, 200) + '...truncated';
      }
    }
    // If still too large, keep only known-safe fields
    if (JSON.stringify(safeDetails).length > MAX_DETAILS_BYTES) {
      safeDetails = { _truncated: true, url: details.url, outletId: details.outletId, criticName: details.criticName };
    }
  }

  const record = {
    ts: new Date().toISOString(),
    script,
    showId,
    file: resolvedFile,
    reason,
    details: safeDetails,
  };

  const line = JSON.stringify(record);

  // Always emit to stdout with [EXCLUSION] prefix so CI logs are greppable
  console.log('[EXCLUSION] ' + line);

  // Append to daily JSONL file
  try {
    ensureAuditDir();
    fs.appendFileSync(getTodayJsonlPath(), line + '\n', { flag: 'a' });
  } catch (err) {
    process.stderr.write(`[exclusion-logger] File write failed: ${err.message}\n`);
  }
}

// Reset dir-ensured flag — used by tests to simulate fresh process
function _resetForTest() {
  auditDirEnsured = false;
}

module.exports = { logExclusion, getTodayJsonlPath, _resetForTest };
