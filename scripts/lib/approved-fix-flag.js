'use strict';

/**
 * approved-fix-flag.js: read-only check for a flag a human-approved data plan
 * set. Lives apart from review-field-edit.js (which requires the write guard)
 * so read-only callers such as wrong-production-autoclear.js keep a write-free
 * require graph (safe-form-allowlist.test.mjs, BRO-5166).
 */

/**
 * True when an approved fix (a human-approved data plan) set `field` to true on
 * this record. Heuristic clearers check this so they never undo a human verdict
 * (BRO-4599: flag-combined-reviews.js re-clearing a human wrongShow flag).
 */
function hasApprovedFlag(record, field) {
  return Array.isArray(record && record.approvedFixes)
    && record.approvedFixes.some((f) => f && f.field === field && f.newValue === true);
}

module.exports = { hasApprovedFlag };
