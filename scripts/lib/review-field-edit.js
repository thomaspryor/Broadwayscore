/**
 * review-field-edit — the per-field review-text edit action for
 * execute-approved-fix.js (BRO-4216).
 *
 * Cloud sessions (iOS / claude.ai) cannot write the private review-texts repo
 * without a manual approval each time, and a repo's checked-in settings cannot
 * pre-authorize it (auto mode ignores project-level autoMode rules by design).
 * So a session lands a plan in data/pending-fixes/ and CI applies it here, the
 * same path the feedback pipeline's approved fixes already take.
 *
 * Guardrails, all enforced by applyReviewFieldEdit (pure, no I/O):
 *   - field allowlist (REVIEW_TEXT_EDITABLE_FIELDS): verdict flags, their
 *     human-clear markers, byline/date and the rejection fields. Never text,
 *     scores or pipeline bookkeeping.
 *   - compare-and-set: the current value must equal action.oldValue, so a plan
 *     never overwrites something CI changed after it was written.
 *   - _locked records are refused.
 *   - every edit is stamped on the record (approvedFixes), so the provenance
 *     survives in the private repo.
 */

// Clears of a protected flag go through its human-clear marker, not a raw
// null: the protected-field restore would otherwise put the flag back (see
// PROTECTED_FIELDS / CLEAR_BREADCRUMBS in review-write-guard.js).
const REVIEW_TEXT_EDITABLE_FIELDS = [
  // byline / metadata
  'criticName', 'publishDate', 'designation',
  // ensemble rejection (not protected; null clears it)
  'rejectedAt', 'rejectedBy', 'rejectionReason', 'rejectionReasoning',
  // verdict flags and their human-clear markers
  'wrongAttribution', 'wrongAttributionReason',
  'wrongProduction', 'wrongProductionReason', 'wrongProductionManualClear',
  'wrongShow', 'wrongShowManualClear',
  'isNotReviewManualClear',
  // duplicate pointer (a clear needs duplicateClearReason alongside it)
  'duplicateOf', 'duplicateReason', 'duplicateClearReason',
];

function isScalar(v) {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v);
}

/**
 * Validate and apply one edit to a parsed review-text record.
 * @param {object} record  parsed review-text JSON (not mutated)
 * @param {{field:string, oldValue:any, newValue:any}} action
 * @param {{fixId:string, at:string}} stamp  plan id + ISO time for provenance
 * @returns {{ok:true, record:object, msg:string} | {ok:false, reason:string}}
 */
function applyReviewFieldEdit(record, action, stamp) {
  if (!record || typeof record !== 'object') return { ok: false, reason: 'record is not an object' };
  const { field, oldValue, newValue } = action || {};
  if (!REVIEW_TEXT_EDITABLE_FIELDS.includes(field)) {
    return { ok: false, reason: `Field "${field}" not allowed for review-field-edit` };
  }
  if (!isScalar(newValue) || !isScalar(oldValue === undefined ? null : oldValue)) {
    return { ok: false, reason: `${field}: oldValue/newValue must be scalar or null` };
  }
  if (record._locked === true) return { ok: false, reason: 'record is _locked' };
  const current = record[field] === undefined ? null : record[field];
  const expected = oldValue === undefined ? null : oldValue;
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    return { ok: false, reason: `${field}: current value doesn't match expected (data changed since plan was created)` };
  }
  if (field === 'duplicateOf' && newValue === null && !record.duplicateClearReason) {
    return { ok: false, reason: 'clearing duplicateOf needs a duplicateClearReason edit first (else the write guard restores it)' };
  }
  const next = { ...record, [field]: newValue };
  const prior = Array.isArray(record.approvedFixes) ? record.approvedFixes : [];
  next.approvedFixes = [...prior, { fixId: stamp.fixId, field, at: stamp.at }];
  return { ok: true, record: next, msg: `${field}: ${JSON.stringify(expected)} -> ${JSON.stringify(newValue)}` };
}

/**
 * Resolve a plan's review path ("<showId>/<file>.json") inside the
 * review-texts root. Returns null when it escapes the root or is not a
 * per-show JSON file.
 */
function resolveReviewPath(reviewTextsDir, rel) {
  const path = require('path');
  if (typeof rel !== 'string' || !/^[a-z0-9][a-z0-9-]*\/[^/]+\.json$/.test(rel)) return null;
  const abs = path.resolve(reviewTextsDir, rel);
  if (!abs.startsWith(path.resolve(reviewTextsDir) + path.sep)) return null;
  return abs;
}

/**
 * Keys the write guard changed besides the edited field and the provenance
 * stamp. The guard may legitimately add side effects on a write (a date
 * edit can auto-flag wrongProduction; the temporal guard can reset
 * criticName; a URL collision can set duplicateOf). An approved fix must not
 * report success while one of those quietly changed what ships (ship-check).
 */
function unexpectedChanges(before, after, field) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const changed = [];
  for (const k of keys) {
    if (k === field || k === 'approvedFixes') continue;
    if (JSON.stringify(before[k] === undefined ? null : before[k]) !== JSON.stringify(after[k] === undefined ? null : after[k])) changed.push(k);
  }
  return changed.sort();
}

module.exports = { REVIEW_TEXT_EDITABLE_FIELDS, applyReviewFieldEdit, resolveReviewPath, unexpectedChanges };
