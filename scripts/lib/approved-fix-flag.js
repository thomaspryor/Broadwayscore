'use strict';

/**
 * approved-fix-flag.js: read-only check for a flag a human-approved data plan
 * set. Lives apart from review-field-edit.js (which requires the write guard)
 * so read-only callers such as wrong-production-autoclear.js keep a write-free
 * require graph (safe-form-allowlist.test.mjs, BRO-5166).
 */

const crypto = require('crypto');
const { EXCERPT_FIELDS } = require('./excerpt-fields');

/**
 * The content an approver judged: the review's url plus its body (fullText, or
 * the aggregator excerpts when there is no body yet). BRO-6676 (The Heart,
 * 2026-10-30): bro-4953 flagged placeholder excerpts wrongShow on 10-10; the
 * real NYT/NYTG/TheaterMania reviews landed on the same files on 10-29 and the
 * lock kept hiding them, because it never knew what it had judged.
 */
function approvedFixBinding(record) {
  const r = record || {};
  const body = typeof r.fullText === 'string' && r.fullText.trim()
    ? r.fullText.trim()
    : EXCERPT_FIELDS.map((f) => (typeof r[f] === 'string' ? r[f].trim() : '')).filter(Boolean).join('\n');
  const url = typeof r.url === 'string' ? r.url.trim() : '';
  return {
    url,
    contentHash: crypto.createHash('sha1').update(body).digest('hex').slice(0, 16),
  };
}

/** True when an approved-fix entry still describes the record's current content. */
function approvedFixStillBound(entry, record) {
  if (!entry || !entry.boundTo) return true; // legacy entry: no binding was recorded
  const now = approvedFixBinding(record);
  return entry.boundTo.url === now.url && entry.boundTo.contentHash === now.contentHash;
}

/**
 * True when an approved fix (a human-approved data plan) set `field` to true on
 * this record AND the content it judged is still the record's content. Heuristic
 * clearers check this so they never undo a human verdict (BRO-4599:
 * flag-combined-reviews.js re-clearing a human wrongShow flag), but a verdict
 * about placeholder content stops binding once the url or body changes
 * (BRO-6676).
 */
function hasApprovedFlag(record, field) {
  return Array.isArray(record && record.approvedFixes)
    && record.approvedFixes.some((f) => f && f.field === field && f.newValue === true
      && approvedFixStillBound(f, record));
}

module.exports = { hasApprovedFlag, approvedFixBinding, approvedFixStillBound };
