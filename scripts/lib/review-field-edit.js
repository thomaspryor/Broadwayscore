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
  // provenance of publishDate (BRO-5090): a date fix re-labels a provisional
  // 'llm-scoring' / 'roundup-article' source, or guards keep ignoring the date
  'dateSource',
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
  // originalScore (BRO-4849): a critic's rating a human checked against the
  // outlet page. The rest of the rating set (normalized, source, type,
  // starRating, scoreSource, the cleared breadcrumb) is derived by
  // verified-original-score.js, never edited on its own. null clears.
  'originalScore',
];

// Per-field value checks beyond "scalar". Returns an error string or null.
const FIELD_VALUE_CHECKS = {
  originalScore: (v, record) => require('./verified-original-score').verifiedRatingError(record, v),
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
    if (record.outletId && isCrossOutletUrl(record.outletId, v) && !splitRelabelUndo(record, v)) return `url: new value belongs to another outlet than ${record.outletId}`;
    return null;
  },
};

// An outlet split (BRO-5128, outlet-mismatch-heal splitOutletCorrection)
// relabels a file by its url, so a wrong url can move a review to the wrong
// side of the split before its url fix lands (BRO-4190: a British Theatre Guide
// review stored with a britishtheatre.com cast-page url). The url fix then
// undoes that relabel: only when the split was made from the current url and
// the new url belongs to the outlet the split moved the file away from.
function splitRelabelUndo(record, newUrl) {
  const from = record.outletIdCorrectedFrom;
  const why = String(record.outletIdCorrectedReason || '');
  if (!from || !record.url || !why.startsWith(`outlet-split: ${record.url} resolves to ${record.outletId} (`)) return null;
  const { resolveOutletFromUrl } = require('./review-normalization');
  const owner = resolveOutletFromUrl(newUrl);
  if (!owner || owner.outletId !== from) return null;
  return { outletId: from, outlet: owner.displayName || from };
}

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
    if (field === 'wrongProduction') {
      guard.invalidateWrongProductionAutoClear(next);
      // BRO-5000: a script-made clear (ManualClear/Override*) outranks nothing; a human
      // clear is a verdict this plan must not overrule silently.
      const sc = guard.retractScriptWrongProductionClear(next);
      if (sc.blockedByHumanClear) {
        return { ok: false, reason: `wrongProduction: record carries a human clear (${guard.WRONG_PRODUCTION_CLEAR_MARKERS.filter((k) => next[k] != null).join(', ')}); a flag plan will not overrule it` };
      }
    }
    else guard.invalidateWrongShowAutoClear(next);
    sideEffectKeys = unexpectedChanges(beforeRetract, next, field);
  }
  if (field === 'url' && newValue) {
    // Same markers as review-normalization maybeUpgradeUrl: the collector
    // refetches a url-corrected review past its wrong-content cooldown.
    next.urlCorrectedFrom = record.url || null;
    next.urlCorrectedReason = `approved fix ${stamp.fixId}: current url was wrong for this file`;
    next.needsRefetch = true;
    const undo = splitRelabelUndo(record, newValue);
    if (undo) {
      next.outletId = undo.outletId;
      next.outlet = undo.outlet;
      next.outletIdCorrectedFrom = record.outletId;
      next.outletIdCorrectedReason = `approved fix ${stamp.fixId}: outlet-split relabel undone, it was made from the wrong url`;
    }
  }
  if (field === 'originalScore') {
    // The helper owns the whole rating write, so it starts from the stored value.
    next.originalScore = record.originalScore === undefined ? null : record.originalScore;
    const beforeRating = { ...next };
    const r = require('./verified-original-score').applyVerifiedOriginalScore(next, newValue, `approved fix ${stamp.fixId}: rating verified against the outlet page`);
    if (!r.ok) return { ok: false, reason: r.reason };
    sideEffectKeys = unexpectedChanges(beforeRating, next, field);
  }
  const prior = Array.isArray(record.approvedFixes) ? record.approvedFixes : [];
  next.approvedFixes = [...prior, { fixId: stamp.fixId, field, at: stamp.at, newValue }];
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
    // only when THIS edit made the undo: the marker stays on the file afterwards
    if (after && after.outletIdCorrectedReason !== (before || {}).outletIdCorrectedReason
      && / outlet-split relabel undone,/.test(String(after.outletIdCorrectedReason || ''))) {
      for (const k of ['outletId', 'outlet', 'outletIdCorrectedFrom', 'outletIdCorrectedReason']) expected.add(k);
    }
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

/**
 * Apply one review-field-edit action to a file under `reviewTextsDir` through the write guard, and report what
 * actually landed. execute-approved-fix.js runs it on data/review-texts; lib/preflight-review-fix-plan.js runs it on
 * a throwaway copy, so a plan is proven before it lands (BRO-4849: a write tripped the guard's url-collision duplicate
 * marking, which only the real write showed).
 */
function executeReviewFieldEditIn(reviewTextsDir, action, stamp) {
  const fs = require('fs');
  const path = require('path');
  const abs = resolveReviewPath(reviewTextsDir, action.file);
  if (!abs) return { ok: false, reason: `Bad review path: ${action.file}` };
  if (!fs.existsSync(abs)) return { ok: false, reason: `Review file not found: ${action.file}` };
  const record = JSON.parse(fs.readFileSync(abs, 'utf8'));
  // url edits (BRO-4430) may repair a url that a sibling file holds for a
  // different named critic; that needs the show dir, so it is computed here.
  const ctx = {};
  if (action.field === 'url' && record.url) {
    const { urlOwnedByOtherCritic } = require('./review-slot-guards');
    ctx.currentUrlOwnedByOtherCritic = !!urlOwnedByOtherCritic({
      showDir: path.dirname(abs), url: record.url,
      selfFilename: path.basename(abs), selfCriticName: record.criticName,
    });
  }
  const res = applyReviewFieldEdit(record, action, stamp, ctx);
  if (!res.ok) return res;
  // A copy: the guard restores protected fields by mutating what it is handed, which would hide a revert below.
  require('./review-write-guard').safeWriteReview(abs, { ...res.record }, action.field === 'url' ? { approvedUrlRepair: true } : {});
  // The write guard can legitimately refuse a change (a protected field with
  // no clear breadcrumb). Report that instead of claiming success.
  const after = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const got = after[action.field] === undefined ? null : after[action.field];
  if (JSON.stringify(got) !== JSON.stringify(action.newValue)) {
    return { ok: false, reason: `${action.file} ${action.field}: write guard kept ${JSON.stringify(got)}` };
  }
  // Side effects the edit made itself (BRO-4849: the derived rating fields) must
  // survive the write too, or a half-written rating would report success.
  const lost = (res.sideEffectKeys || []).filter((k) => JSON.stringify(after[k] ?? null) !== JSON.stringify(res.record[k] ?? null));
  if (lost.length) {
    return { ok: false, reason: `${action.file} ${action.field}: write guard reverted ${lost.join(', ')}` };
  }
  const extra = unexpectedChanges(record, after, action.field, res.sideEffectKeys || []);
  if (extra.length) {
    return { ok: false, reason: `${action.file} ${action.field} applied, but the write guard also changed ${extra.join(', ')}; check the record before trusting it` };
  }
  return { ok: true, msg: `${action.file} ${res.msg}` };
}

module.exports = { REVIEW_TEXT_EDITABLE_FIELDS, applyReviewFieldEdit, resolveReviewPath, unexpectedChanges, executeReviewFieldEditIn };
