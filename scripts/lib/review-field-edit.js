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
 *     human-clear markers, byline/date, the rejection fields, and (BRO-4275)
 *     the human score override, the review URL and the pull quote. Never
 *     fullText, LLM/ensemble scores or pipeline bookkeeping. Score, URL and
 *     quote values are range/format/verbatim checked (FIELD_VALUE_CHECKS).
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
  // score override (BRO-4275): humanReviewScore is the one score the rebuild
  // always honours (rebuild-helpers.js P0), so a cloud session can correct an
  // LLM misread without touching llmScore/ensemble bookkeeping.
  'humanReviewScore', 'humanReviewScoreProvisional', 'humanReviewNote',
  // review link and the pull quote shown on the site (BRO-4275)
  'url', 'llmPullQuote',
];

// Per-field value checks beyond "scalar". Returns an error string or null.
const FIELD_VALUE_CHECKS = {
  humanReviewScore: (v) => (v === null || (Number.isInteger(v) && v >= 1 && v <= 100)
    ? null : 'humanReviewScore must be an integer 1-100 or null'),
  humanReviewScoreProvisional: (v) => (v === null || typeof v === 'boolean'
    ? null : 'humanReviewScoreProvisional must be boolean or null'),
  humanReviewNote: (v) => (v === null || (typeof v === 'string' && v.trim().length > 0)
    ? null : 'humanReviewNote must be a non-empty string or null'),
  url: (v) => (typeof v === 'string' && /^https:\/\/[^\s]+$/.test(v)
    ? null : 'url must be an https URL'),
  // A pull quote is printed as the critic's words, so it must be verbatim
  // from the stored review text (whitespace/quote-mark insensitive).
  llmPullQuote: (v, record) => {
    if (v === null) return null;
    if (typeof v !== 'string' || v.trim().length < 20) return 'llmPullQuote must be a string of 20+ chars';
    const norm = (t) => String(t || '').replace(/[\u2018\u2019\u201c\u201d'"]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!record.fullText || !norm(record.fullText).includes(norm(v))) {
      return 'llmPullQuote must appear verbatim in the review fullText';
    }
    return null;
  },
};

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
  const valueCheck = FIELD_VALUE_CHECKS[field];
  const valueError = valueCheck ? valueCheck(newValue, record) : null;
  if (valueError) return { ok: false, reason: valueError };
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

module.exports = { REVIEW_TEXT_EDITABLE_FIELDS, applyReviewFieldEdit, resolveReviewPath };
