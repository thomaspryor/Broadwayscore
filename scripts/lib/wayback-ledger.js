'use strict';
/**
 * wayback-ledger.js (BRO-7944): ledger rows for scripts/recover-wayback-reviews.js
 * (the drain-not-attempted.yml / recover-wayback job) so its attempts and landings
 * are in the same gap-recovery ledger the driver and nightly digest read. Strategy
 * 'ARCHIVE' (same source as the driver's Wayback strategy). A ledger failure must
 * never break recovery: every call here is best-effort.
 */
const fs = require('fs');
const L = require('./gap-recovery-ledger');

const PENDING = new Map(); // reviewKey -> attempt info (for the recovered row at landing)

function safe(fn) { try { return fn(); } catch (e) { console.log(`    [ledger] ${e.message}`); return null; } }

function textLen(filePath) {
  try { return String(JSON.parse(fs.readFileSync(filePath, 'utf8')).fullText || '').length; } catch { return null; }
}

/** @returns {number|null} the file's current fullText length, taken BEFORE the write */
function snapshotBefore(candidate) { return textLen(candidate.filePath); }

/** One attempt that produced no text. outcome: 'rejected' | 'no_evidence' | 'non_evidence'. */
function recordRefusal(candidate, { outcome, reason, bytesBefore = null, url = null, error = null, httpStatus = null, ledgerPath }) {
  return safe(() => L.appendRows([{
    reviewKey: L.reviewKeyOf(candidate.filePath), gapClass: candidate.gapClass || null, strategy: 'ARCHIVE', outcome, reason,
    url: url || candidate.url || null, runId: `wayback-${process.pid}`, bytesBefore, bytesAfter: 0, tier: candidate.contentTier || null, error, httpStatus,
  }], ledgerPath));
}

/** An accepted write (text on disk, not yet pushed): pending_push row + info for the landing row. */
function recordAccepted(candidate, { bytesBefore = null, url = null, via = 'archive', ledgerPath }) {
  return safe(() => {
    const key = L.reviewKeyOf(candidate.filePath);
    const info = { reviewKey: key, gapClass: candidate.gapClass || null, strategy: 'ARCHIVE', url: url || candidate.url || null, bytesBefore, bytesAfter: textLen(candidate.filePath), runId: `wayback-${process.pid}` };
    PENDING.set(key, info);
    L.appendRows([{ ...info, outcome: 'pending_push', reason: 'accepted', detail: { via } }], ledgerPath);
    return info;
  });
}

/** onLanded callback for checkpointReviewTexts / retryPendingPushes: the recovered row, once on origin/main. */
function onLanded(landed, ledgerPath) {
  return safe(() => {
    const key = L.reviewKeyOf(landed.path || landed.abs || landed.rel);
    const info = PENDING.get(key)
      || (landed.meta && landed.meta.attempts && landed.meta.attempts[key])
      || L.pendingPushInfo(L.readRows(ledgerPath || L.ledgerPathDefault())).get(key);
    if (!info) return;
    L.appendRows([L.recoveredRowFromLanding(landed, info)], ledgerPath);
    PENDING.delete(key);
  });
}

function attemptsFor(paths) {
  const out = {};
  for (const p of paths) { const k = L.reviewKeyOf(p); if (PENDING.has(k)) out[k] = PENDING.get(k); }
  return out;
}

module.exports = { snapshotBefore, recordRefusal, recordAccepted, onLanded, attemptsFor, PENDING };
