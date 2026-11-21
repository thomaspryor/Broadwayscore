// Shared recency comparator for data/opening-night-sent.json merge paths
// (task #1914). Used by both scripts/lib/opening-night-tracker-sync.js
// (REST/gh-api sync, mergeTrackerEntries) and scripts/lib/merge-opening-night-sent.js
// (git-push conflict merge, mergeOpeningNightSent) so the two independent
// reconciliation paths for this file agree on what "newer" means.
//
// Field list is deliberately a CONTENT-CHANGE timestamp allowlist, not
// "every timestamp-shaped field on the record". Two fields that look like
// candidates are deliberately EXCLUDED because they are *observation*
// timestamps (when something happened to notice/touch the record), not
// *content* timestamps (when the record's real-world state changed) — both
// caught by adversarial review of earlier drafts of this fix (task #1914):
//   - `lastReconciledAt` (scripts/lib/broadcast-state.js
//     applyResendStatusUpdate) is set on every reconciler poll, including
//     no-op polls where draftStatus didn't change. Including it would let a
//     stale-but-recently-polled record outrank a genuinely newer `sentAt`
//     write from a different writer, silently reverting draftStatus from
//     'sent' back to 'draft'/'queued' on origin.
//   - `_migratedAt` (scripts/lib/broadcast-state.js migrateSentRecord) is
//     stamped with "now" the moment a pre-#1853 legacy record (one with no
//     draftStatus field yet) happens to get touched by migration-aware code
//     — which can be long after that record's real content last changed.
//     Including it would let an old, genuinely-stale legacy record that
//     just got migrated look artificially fresher than a real concurrent
//     write, purely because the migration ran recently. (migrateSentRecord
//     already backfills `sentAt` from `draftCreatedAt` for the one legacy
//     shape where a real content timestamp exists, so sentAt/draftCreatedAt
//     alone cover every case that has genuine recency information.)
//
// If a future writer adds a new content-defining field to a record shape in
// this file, add it here too — this list is the single point that both
// merge paths trust.
// discardedAt (BRO-2935): a discarded record keeps the stale copy's
// draftCreatedAt and has sentAt:null, so without it a merge tie would hand the
// win to a pre-discard copy and resurrect a deleted draft as pending.
const RECENCY_FIELDS = ['sentAt', 'draftCreatedAt', 'discardedAt'];

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

// BRO-6634: owner-notice stamps on an unsent draft. They are NOT recency
// fields (a reminder stamped after the owner pressed Send must never outrank
// the sentAt another writer recorded), so a merge that keeps the other copy
// of the record would drop them, and the next run would repeat the "draft
// updated" email or restart the reminder count. Each group travels with its
// timestamp: the newer stamp wins whichever copy wins the record.
const DRAFT_STAMP_GROUPS = [
  ['draftUpdatedAt', ['draftNumbers', 'reviewCount']],
  ['draftReminderAt', ['draftReminderCount']],
];

const stampMs = v => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : 0);

/**
 * `winner` with any newer draft stamps from `loser` copied over, when both
 * copies describe the same Resend draft. Returns `winner` unchanged otherwise.
 */
function carryDraftStamps(winner, loser) {
  if (!winner || !loser || typeof winner !== 'object' || typeof loser !== 'object') return winner;
  if (!winner.draftId || winner.draftId !== loser.draftId) return winner;
  let out = winner;
  for (const [at, fields] of DRAFT_STAMP_GROUPS) {
    if (stampMs(loser[at]) <= stampMs(winner[at])) continue;
    out = { ...out, [at]: loser[at] };
    for (const f of fields) if (Object.hasOwn(loser, f)) out[f] = loser[f];
  }
  return out;
}

module.exports = { recordRecencyMs, RECENCY_FIELDS, carryDraftStamps };
