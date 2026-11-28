/**
 * Persistence helpers for bug diagnoses awaiting GitHub-issue creation.
 *
 * Why this exists: process-feedback.yml marks submissions as processed
 * (tracking commit, if: always()) independently of the issue-creation step
 * (if: success()). A run cancelled between the two loses the diagnosis forever
 * — the submission never re-surfaces. That swallowed Erik Andersen's
 * homepage-filter bug report on 2026-07-07 (run 28876301784, job hit
 * timeout-minutes during push-with-retry). Diagnoses therefore persist in
 * data/audit/pending-bug-diagnoses.json (committed alongside the tracking
 * file) and the workflow drains the file after each issue is created.
 */

const fs = require('fs');

/**
 * Load diagnoses left over from a run cancelled before issue creation.
 * Missing/corrupt/non-array file → [].
 */
function loadPendingDiagnoses(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Merge leftover pending diagnoses with freshly produced ones, deduped by
 * submission ID (fresh wins — it has the newest diagnosis for that submission).
 * `idFn` is process-feedback.js's submissionId() — passed in so the two files
 * can't drift on what identifies a submission.
 */
function mergePendingDiagnoses(pending, fresh, idFn) {
  const freshIds = new Set(fresh.map(d => idFn(d.submission || {})).filter(Boolean));
  return [
    ...pending.filter(d => !freshIds.has(idFn(d.submission || {}))),
    ...fresh,
  ];
}

module.exports = { loadPendingDiagnoses, mergePendingDiagnoses };
