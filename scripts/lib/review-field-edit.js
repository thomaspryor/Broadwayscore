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
 *     the human score override and the pull quote. Never fullText, the URL,
 *     LLM/ensemble scores or pipeline bookkeeping. Score and quote values are
 *     range/verbatim checked (FIELD_VALUE_CHECKS).
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
  // Gemini/CV non-review verdict (BRO-4429): the isNonReview family is what
  // classify-non-reviews.js stamps; isNotReview* above is the write-guard's.
  'isNonReview', 'isNonReviewReason', 'nonReviewManualClear', 'wrongArticleManualClear',
  // duplicate pointer (a clear needs duplicateClearReason alongside it)
  'duplicateOf', 'duplicateReason', 'duplicateClearReason',
  // score override (BRO-4275): humanReviewScore is the one score the rebuild
  // always honours (rebuild-helpers.js P0), so a cloud session can correct an
  // LLM misread without touching llmScore/ensemble bookkeeping.
  'humanReviewScore', 'humanReviewScoreProvisional', 'humanReviewNote',
  // the pull quote shown on the site (BRO-4275). `url` stays out: a URL change
  // trips url-change-invariant.js, which wipes fullText/score and refetches.
  'llmPullQuote',
  // url (BRO-4430): only to REPAIR a wrong url, never to replace a real
  // review url. See FIELD_VALUE_CHECKS.url for the narrow conditions; the
  // write then runs url-change-invariant (clears old-url-derived state) and
  // the collector refetches the new url (needsRefetch + urlCorrectedFrom).
  'url',
];

// Per-field value checks beyond "scalar". Returns an error string or null.
const FIELD_VALUE_CHECKS = {
  // No null: both are write-guard PROTECTED_FIELDS with no clear breadcrumb,
  // so a clear would be silently restored on write.
  humanReviewScore: (v) => (Number.isInteger(v) && v >= 1 && v <= 100
    ? null : 'humanReviewScore must be an integer 1-100'),
  humanReviewScoreProvisional: (v) => (v === null || typeof v === 'boolean'
    ? null : 'humanReviewScoreProvisional must be boolean or null'),
  humanReviewNote: (v) => (typeof v === 'string' && v.trim().length > 0
    ? null : 'humanReviewNote must be a non-empty string'),
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
  // A url edit is allowed only when the CURRENT url is provably wrong for this
  // file: an aggregator/round-up page, a non-review page (show page, cast
  // announcement), or another named critic's review a sibling file already
  // holds (ctx.currentUrlOwnedByOtherCritic, computed by the executor).
  // The new value must be a review-candidate url on this outlet's own domain,
  // or '' (only when the current url is an aggregator page: a Theatre Record
  // text is stored with no url, and '' restores that shape without clearing
  // the text, since '' is not a url change for url-change-invariant).
  url: (v, record, ctx = {}) => {
    const { isAggregatorPageUrl } = require('./review-slot-guards');
    const { classifyReviewUrl } = require('./non-review-url-patterns');
    const current = record.url || '';
    const currentAggregator = isAggregatorPageUrl(current);
    const currentWrong = currentAggregator
      || (current && classifyReviewUrl(current).ok === false)
      || ctx.currentUrlOwnedByOtherCritic === true;
    if (!currentWrong) return 'url: the current url is not provably wrong (aggregator, non-review page, or another critic\'s review)';
    if (v === '') return currentAggregator ? null : 'url: clearing to "" is only for an aggregator-page url';
    if (typeof v !== 'string' || !/^https?:\/\//i.test(v)) return 'url must be an http(s) url or ""';
    if (!classifyReviewUrl(v).ok || isAggregatorPageUrl(v)) return 'url: new value is not a review-candidate url';
    const { isCrossOutletUrl } = require('./review-normalization');
    if (record.outletId && isCrossOutletUrl(record.outletId, v)) return `url: new value belongs to another outlet than ${record.outletId}`;
    return null;
  },
};

// Bookkeeping a url edit legitimately changes besides `url` itself: the
// url-change-invariant clear (breadcrumb + the fields it names) and the
// refetch markers set below.
const URL_EDIT_SIDE_EFFECT_KEYS = ['_urlChangedClear', 'duplicateClearReason', 'needsRefetch', 'urlCorrectedFrom', 'urlCorrectedReason'];

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
function applyReviewFieldEdit(record, action, stamp, ctx = {}) {
  if (!record || typeof record !== 'object') return { ok: false, reason: 'record is not an object' };
  const { field, oldValue, newValue } = action || {};
  if (!REVIEW_TEXT_EDITABLE_FIELDS.includes(field)) {
    return { ok: false, reason: `Field "${field}" not allowed for review-field-edit` };
  }
  if (!isScalar(newValue) || !isScalar(oldValue === undefined ? null : oldValue)) {
    return { ok: false, reason: `${field}: oldValue/newValue must be scalar or null` };
  }
  const valueCheck = FIELD_VALUE_CHECKS[field];
  const valueError = valueCheck ? valueCheck(newValue, record, ctx) : null;
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
  // A human verdict setting the flag must retract any earlier machine
  // auto-clear, or isEffectivelyWrongProductionOrShow keeps reading the flag
  // as cleared and the review stays live (BRO-4432; the helper's contract:
  // "every wrongProduction = true writer should call this").
  let sideEffectKeys = [];
  if (newValue === true && (field === 'wrongProduction' || field === 'wrongShow')) {
    const guard = require('./review-write-guard');
    const beforeRetract = { ...next };
    if (field === 'wrongProduction') guard.invalidateWrongProductionAutoClear(next);
    else guard.invalidateWrongShowAutoClear(next);
    sideEffectKeys = unexpectedChanges(beforeRetract, next, field);
  }
  if (field === 'url' && newValue) {
    // Same markers as review-normalization maybeUpgradeUrl: the collector
    // refetches a url-corrected review past its wrong-content cooldown.
    next.urlCorrectedFrom = record.url || null;
    next.urlCorrectedReason = `approved fix ${stamp.fixId}: current url was wrong for this file`;
    next.needsRefetch = true;
  }
  const prior = Array.isArray(record.approvedFixes) ? record.approvedFixes : [];
  next.approvedFixes = [...prior, { fixId: stamp.fixId, field, at: stamp.at }];
  const retractMsg = sideEffectKeys.length ? ` (retracted ${sideEffectKeys.join(', ')})` : '';
  return { ok: true, record: next, sideEffectKeys, msg: `${field}: ${JSON.stringify(expected)} -> ${JSON.stringify(newValue)}${retractMsg}` };
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
function unexpectedChanges(before, after, field, expectedKeys = []) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const changed = [];
  const expected = new Set();
  if (field === 'url') {
    for (const k of URL_EDIT_SIDE_EFFECT_KEYS) expected.add(k);
    const bc = after && after._urlChangedClear;
    if (bc && bc.to === after.url && Array.isArray(bc.cleared)) bc.cleared.forEach((k) => expected.add(k));
  }
  // BRO-4888: the write guard resolves a duplicate-pointer pair itself. Setting
  // duplicateClearReason on a file that points at a same-url sibling makes it
  // refuse the cycle and clear that file's own duplicateOf/duplicateReason;
  // setting duplicateOf stamps its own duplicateReason and may null the clear
  // reason. Those are the intended outcome, not surprises. Value-aware on
  // purpose: a guard that SETS a pointer while the plan edits a reason field
  // still counts as unexpected.
  if (field === 'duplicateClearReason' && after && after[field] != null) {
    for (const k of ['duplicateOf', 'duplicateReason']) if (after[k] == null) expected.add(k);
  }
  if (field === 'duplicateOf' && after && after[field] != null) {
    if (after.duplicateReason === 'url-collision-detected-at-write') expected.add('duplicateReason');
    if (after.duplicateClearReason == null) expected.add('duplicateClearReason');
  }
  for (const k of keys) {
    if (k === field || k === 'approvedFixes' || expectedKeys.includes(k) || expected.has(k)) continue;
    if (JSON.stringify(before[k] === undefined ? null : before[k]) !== JSON.stringify(after[k] === undefined ? null : after[k])) changed.push(k);
  }
  return changed.sort();
}

module.exports = { REVIEW_TEXT_EDITABLE_FIELDS, applyReviewFieldEdit, resolveReviewPath, unexpectedChanges };
