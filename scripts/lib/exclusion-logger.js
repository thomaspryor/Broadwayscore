'use strict';

const fs = require('fs');
const path = require('path');

const AUDIT_DIR = process.env.EXCLUSION_LOGGER_AUDIT_DIR
  || path.join(__dirname, '../../data/audit');

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

  const resolvedFile = (file !== undefined && file !== null) ? file : '-';

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
