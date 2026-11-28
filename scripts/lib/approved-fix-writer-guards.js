'use strict';

const { approvedFixStillBound } = require('./approved-fix-flag');

// Match exclusion-field semantics: deleting a false/null flag is a no-op.
const normalized = (v) => v == null || v === false || v === '' ? null : v;

/** The newest approved-fix stamp for `field` that still describes this record's content, else null. */
function latestBoundApproval(record, field) {
  let latest = null;
  for (const stamp of Array.isArray(record?.approvedFixes) ? record.approvedFixes : []) {
    if (!stamp || stamp.field !== field || !Object.hasOwn(stamp, 'newValue')) continue;
    if (!latest || String(stamp.at || '') >= String(latest.at || '')) latest = stamp;
  }
  return latest && approvedFixStillBound(latest, record) ? latest : null;
}

/** Scheduled writers must respect the newest approval about this content. */
function canChangeApprovedField(record, field, nextValue) {
  if (record?._locked === true) return false;
  const latest = latestBoundApproval(record, field);
  return !latest || normalized(latest.newValue) === normalized(nextValue);
}

/**
 * True when the record's current, non-empty `field` value is exactly what the
 * newest bound approval set (BRO-7174). Heuristic "this pointer looks stale"
 * checks treat it like protectedFields: a human approved this pointer for this
 * content, so a url-mismatch heal must not clear it.
 */
function holdsApprovedValue(record, field) {
  const current = normalized(record?.[field]);
  if (current == null) return false;
  const latest = latestBoundApproval(record, field);
  return !!latest && normalized(latest.newValue) === current;
}

/** Recovery clears both flags, so a held approval on either blocks the write. */
function canRecoverReview(record) {
  return canChangeApprovedField(record, 'wrongShow', null)
    && canChangeApprovedField(record, 'wrongProduction', null);
}

/** The canonical is cleared; the other member must retain its pointer at it. */
function canRepairCircularPair(canonical, loser, canonicalFile) {
  return canChangeApprovedField(canonical, 'duplicateOf', null)
    && canChangeApprovedField(loser, 'duplicateOf', canonicalFile);
}

module.exports = { canChangeApprovedField, canRecoverReview, canRepairCircularPair, holdsApprovedValue, latestBoundApproval };
