/**
 * Merge-aware read-modify-write for data/audit/zero-review-catchup-attempts.json
 * (BRO-3389's attempt memory). Same shape as gap-audit-checkpoint.js: lock,
 * re-read fresh from disk, fold in only the ids this call touched, write
 * atomically — so a concurrent run's stamps for other shows survive.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { withFileLock } = require('./file-lock');

function loadAttempts(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')) || {}; } catch { return {}; }
}

function writeJsonAtomic(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
    fs.renameSync(tmp, filePath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
}

/**
 * Bump the attempt count for each dispatched show id, setting firstAt on
 * first sight and lastAt on every touch.
 * @param {string} filePath
 * @param {string[]} dispatchedIds
 * @param {number} nowMs
 */
function recordAttempts(filePath, dispatchedIds, nowMs) {
  if (!dispatchedIds || dispatchedIds.length === 0) return;
  withFileLock(`${filePath}.lock`, (held) => {
    if (!held) {
      console.error(`::warning::zero-review-catchup-attempts lock could not be acquired for ${filePath} — the read-modify-write ran unprotected.`);
    }
    const current = loadAttempts(filePath);
    const nowIso = new Date(nowMs).toISOString();
    for (const id of dispatchedIds) {
      const entry = current[id] || { attempts: 0, firstAt: nowIso };
      entry.attempts = (entry.attempts || 0) + 1;
      entry.lastAt = nowIso;
      current[id] = entry;
    }
    writeJsonAtomic(filePath, current);
  });
}

module.exports = { loadAttempts, writeJsonAtomic, recordAttempts };
