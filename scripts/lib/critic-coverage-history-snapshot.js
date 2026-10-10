#!/usr/bin/env node
/**
 * critic-coverage-history-snapshot.js — Write a weekly snapshot of critic coverage gaps.
 *
 * Reads:
 *   data/audit/critic-coverage-audit.json   — array of { name, missingCount, ... }
 *   data/audit/critic-coverage-buckets.json — { exactUrlMatch, showOutletMatch, notBroadway,
 *                                               trueMissingBwy, trueMissingWE }
 *
 * Writes:
 *   data/audit/critic-coverage-history/YYYY-MM-DD-HHMMSS.json
 *
 * One file per invocation (seconds in filename) → safe under `git merge -X theirs`
 * because each file is distinct and no append race is possible.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const AUDIT_DIR = path.join(REPO_ROOT, 'data', 'audit');
const AUDIT_FILE = path.join(AUDIT_DIR, 'critic-coverage-audit.json');
const BUCKETS_FILE = path.join(AUDIT_DIR, 'critic-coverage-buckets.json');
const HISTORY_DIR = path.join(AUDIT_DIR, 'critic-coverage-history');

/**
 * Format a Date as "YYYY-MM-DD".
 */
function formatDate(d) {
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${day}`;
}

/**
 * Format a Date as "HHMMSS" (UTC).
 */
function formatTime(d) {
  const h = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  const s = String(d.getUTCSeconds()).padStart(2, '0');
  return `${h}${mi}${s}`;
}

/**
 * Build gapsByBucket counts from the buckets file.
 *
 * Bucket mapping (per audit-critic-coverage-bucket.js):
 *   A = exactUrlMatch
 *   B = showOutletMatch
 *   C = notBroadway
 *   D = trueMissingBwy
 *   E = trueMissingWE
 */
function buildGapsByBucket(buckets) {
  return {
    A: Array.isArray(buckets.exactUrlMatch) ? buckets.exactUrlMatch.length : 0,
    B: Array.isArray(buckets.showOutletMatch) ? buckets.showOutletMatch.length : 0,
    C: Array.isArray(buckets.notBroadway) ? buckets.notBroadway.length : 0,
    D: Array.isArray(buckets.trueMissingBwy) ? buckets.trueMissingBwy.length : 0,
    E: Array.isArray(buckets.trueMissingWE) ? buckets.trueMissingWE.length : 0,
  };
}

/**
 * writeWeeklySnapshot() — main export.
 *
 * Returns the absolute path of the file written.
 */
function writeWeeklySnapshot() {
  // Load source data.
  if (!fs.existsSync(AUDIT_FILE)) {
    throw new Error(`Audit file not found: ${AUDIT_FILE}`);
  }
  if (!fs.existsSync(BUCKETS_FILE)) {
    throw new Error(`Buckets file not found: ${BUCKETS_FILE}`);
  }

  const audit = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8'));
  const buckets = JSON.parse(fs.readFileSync(BUCKETS_FILE, 'utf8'));

  if (!Array.isArray(audit)) {
    throw new Error(`Expected critic-coverage-audit.json to be an array; got ${typeof audit}`);
  }

  // Compute aggregate metrics.
  const totalCritics = audit.length;
  const totalGaps = audit.reduce((sum, c) => sum + (c.missingCount || 0), 0);

  // perCritic: display name → missingCount (omit entries with 0 gaps).
  const perCritic = {};
  for (const c of audit) {
    if (c.name && (c.missingCount || 0) > 0) {
      perCritic[c.name] = c.missingCount;
    }
  }

  // gapsByBucket derived from the pre-classified buckets file.
  const gapsByBucket = buildGapsByBucket(buckets);

  // gapsBySource: currently only muckrack. Hard-coded key; extend here when bww/nysun/nysr land.
  const gapsBySource = {
    muckrack: totalGaps,
  };

  // Timestamp and filename.
  const now = new Date();
  const dateStr = formatDate(now);
  const timeStr = formatTime(now);
  const timestamp = now.toISOString();
  const filename = `${dateStr}-${timeStr}.json`;

  // Ensure history directory exists.
  fs.mkdirSync(HISTORY_DIR, { recursive: true });

  const snapshot = {
    date: dateStr,
    timestamp,
    totalCritics,
    totalGaps,
    gapsByBucket,
    gapsBySource,
    perCritic,
  };

  const outPath = path.join(HISTORY_DIR, filename);
  fs.writeFileSync(outPath, JSON.stringify(snapshot, null, 2) + '\n', 'utf8');

  return outPath;
}

module.exports = { writeWeeklySnapshot };

// Allow direct invocation: node scripts/lib/critic-coverage-history-snapshot.js
if (require.main === module) {
  try {
    const outPath = writeWeeklySnapshot();
    console.log(`Snapshot written → ${outPath}`);
  } catch (err) {
    console.error('ERROR:', err.message);
    process.exit(1);
  }
}
