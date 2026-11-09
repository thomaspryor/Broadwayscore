'use strict';

/**
 * Which _pending/<show>/ files may suppress a URL-less citation in the gap audit (BRO-7163 F11).
 *
 * Only a strand that a recovery path actually works (a no-byline strand awaiting attribution) is
 * "tracked elsewhere". A date_implausible, cross_market_contamination or recreated_previously_excluded_url
 * file can never become a live review, so it must not hide the citation: 894 show/outlet pairs in the
 * 2026-11 corpus had only such a file.
 */
const TRACKED_PENDING_REASONS = new Set(['no-byline']);

function pendingReasonOf(rec) {
  return (rec && (rec.pendingReason || rec.incompleteReason || rec.reason)) || null;
}

/** files: [{ name, rec }] from a _pending/<show> dir. Returns the files whose recovery is tracked. */
function trackedPendingFiles(files) {
  return (files || []).filter((f) => TRACKED_PENDING_REASONS.has(pendingReasonOf(f.rec)));
}

module.exports = { TRACKED_PENDING_REASONS, pendingReasonOf, trackedPendingFiles };
