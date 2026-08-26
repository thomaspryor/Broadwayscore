// Shared recency comparator for data/opening-night-sent.json merge paths
// (task #1914). Used by both scripts/lib/opening-night-tracker-sync.js
// (REST/gh-api sync, mergeTrackerEntries) and scripts/lib/merge-opening-night-sent.js
// (git-push conflict merge, mergeOpeningNightSent) so the two independent
// reconciliation paths for this file agree on what "newer" means.
//
// Field list is deliberately a CONTENT-CHANGE timestamp allowlist, not
// "every timestamp-shaped field on the record". `lastReconciledAt`
// (scripts/lib/broadcast-state.js applyResendStatusUpdate) is set on every
// reconciler poll, including no-op polls where draftStatus didn't change —
// it is an *observation* timestamp, not a *content* timestamp. Including it
// here would let a stale-but-recently-polled record (Resend hasn't yet
// reflected a send that just happened) outrank a genuinely newer `sentAt`
// write from a different writer (e.g. send-opening-night-broadcast.js),
// silently reverting draftStatus from 'sent' back to 'draft'/'queued' on
// origin — the exact clobber this comparator exists to prevent (adversarial
// review of the first draft of this fix caught it; see task #1914).
//
// If a future writer adds a new content-defining field to a record shape in
// this file, add it here too — this list is the single point that both
// merge paths trust.
const RECENCY_FIELDS = ['sentAt', 'draftCreatedAt', '_migratedAt'];

/**
 * Newest parseable timestamp among RECENCY_FIELDS present on `record`, in
 * epoch ms. Returns 0 (never null) when no field parses, so two records with
 * no comparable timestamp compare equal (0 === 0) and the caller's existing
 * default-winner behavior is preserved unchanged — same intent as
 * scripts/lib/merge-critic-registry.js's `Date.parse(x || 0) || 0`, but that
 * exact idiom is NOT reused here: `Date.parse(undefined || 0)` parses the
 * *string* "0" as a bogus non-zero ~year-2000 timestamp instead of failing,
 * which is harmless there (both sides run the identical single-field
 * comparison, so a missing value on both sides still produces equal buggy
 * numbers and falls through to the same default) but would corrupt this
 * function's multi-field MAX(): a genuinely-missing field must contribute
 * nothing, not a fake in-range date. Only real strings are handed to
 * Date.parse.
 */
function recordRecencyMs(record) {
  if (!record || typeof record !== 'object') return 0;
  let max = 0;
  for (const field of RECENCY_FIELDS) {
    const v = record[field];
    if (typeof v !== 'string') continue;
    const t = Date.parse(v);
    if (Number.isFinite(t) && t > max) max = t;
  }
  return max;
}

module.exports = { recordRecencyMs, RECENCY_FIELDS };
