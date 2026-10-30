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
const { isReviewTextFile } = require('./review-text-sidecars');
const { EXCERPT_FIELDS } = require('./excerpt-fields');

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
  // BRO-4695: persist an attribution audit's checked, legitimate byline via
  // approved fixes too. Write the evidence note before setting the marker.
  'crossOutletVerifiedNote', 'crossOutletVerified',
  'wrongProduction', 'wrongProductionReason', 'wrongProductionManualClear',
  // allowCrossMarket (BRO-5499): TRUE ONLY. The rebuild's cross-market guard excludes any .co.uk / london-region
  // outlet reviewing a NYC show and the CV cannot override it; a UK critic who really reviewed the NYC production
  // (Attitude's 3/5 Midnight review) is let through by this per-review marker, not by making the outlet dual-market.
  // It also switches off the content-verifier wrongShow / nonReview / film-TV promotions for that review, and a plan
  // cannot clear it (a manual edit is needed to undo a mistake), so set it only after reading the page.
  'allowCrossMarket',
  'wrongShow', 'wrongShowManualClear',
  // showId (BRO-4317): only to repair a stale id left by a move, and only to the
  // folder the file lives in (FIELD_VALUE_CHECKS.showId). A mismatch can also
  // mean the FILE is misfiled with a correct id; the plan author must confirm
  // the review is about the folder's show. Rebuild keys on the folder, so this
  // edit alone changes no score: it stops audit-cross-show-url-collisions
  // Pre-pass 1 from flagging wrongProduction, and does not clear one it set.
  'showId',
  'isNotReviewManualClear',
  // isNotReview itself (BRO-5373): CLEAR ONLY (false), after the manual-clear
  // breadcrumb above. Without it a plan could stamp the breadcrumb but the flag
  // stayed true and explainExclusion kept the review out (a stale LBO-roundup
  // verdict on a file later refetched as the real Telegraph review).
  'isNotReview', 'isNotReviewReason',
  // Gemini/CV non-review verdict (BRO-4429): the isNonReview family is what
  // classify-non-reviews.js stamps; isNotReview* above is the write-guard's.
  'isNonReview', 'isNonReviewReason', 'nonReviewManualClear', 'wrongArticleManualClear',
  // audit-non-reviews.js's own marker (BRO-5243): CLEAR ONLY, after
  // nonReviewManualClear, as isNotReview below. explainExclusion drops any file
  // carrying it, so a marker stamped on an earlier fragment outlives the real
  // review recovered later (true-west-2019 WSJ, 2026-10-15).
  'nonReviewFlag',
  // showNotMentioned (BRO-5395): CLEAR ONLY, after a showNotMentionedManualClear
  // breadcrumb that says what was checked. evaluateShowMentionGuard honours the
  // breadcrumb, so backfill-review-flags / the collector do not set it again.
  'showNotMentioned', 'showNotMentionedManualClear',
  // BRO-5858: fabricatedEntry is CLEAR ONLY (false). It was stamped in bulk on
  // web-search rows ("84% fabrication rate", Feb 2026), so a row whose url the
  // plan author has fetched and found to be the real review stays excluded and
  // the rebuild scores a same-url twin instead.
  'fabricatedEntry',
  // isRoundupArticle (BRO-4914): CLEAR ONLY (false). A false value is sticky:
  // shouldSkipRoundupAudit stops the CI setters from re-flagging the file.
  'isRoundupArticle',
  // duplicate pointer (a clear needs duplicateClearReason alongside it)
  'duplicateOf', 'duplicateReason', 'duplicateClearReason',
  // cross-outlet duplicate flag (BRO-3870): CLEAR ONLY, with its breadcrumb.
  // For a hand-adjudicated dangling crossOutletPrimaryFile the audit's --fix
  // leaves report-only (the surviving copy is excluded for its own reasons).
  'crossOutletDuplicate', 'crossOutletClearReason',
  // syndication flag (BRO-4891): CLEAR ONLY, and only when the record's
  // syndicatedPrimaryFile points at the record itself. A file cannot be a
  // syndicated copy of itself; the stale self-pointer (left by a rename or
  // merge) drops the outlet's only review from reviews.json.
  'isSyndicatedDuplicate', 'syndicatedPrimaryFile',
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
  // Aggregator excerpts (BRO-4251): CLEAR ONLY. An aggregator can glue another
  // show's review onto this one's excerpt (NYC Theatre put Fat Ham text on
  // Shucked's Variety quote), and selectBestExcerpt prints it. A plan may null
  // the field; it may never write excerpt text (see FIELD_VALUE_CHECKS).
  ...EXCERPT_FIELDS,
  // Sourceless aggregatorStars (BRO-6018): CLEAR ONLY. A relay can copy a sibling row's
  // stars onto another critic's file (Daily Mail stars on the Mail on Sunday rows), and the
  // stars then anchor the score. Only stars with no aggregatorStarsSource may be cleared; the
  // edit queues the file for a normal rescore (see applyReviewFieldEdit).
  'aggregatorStars',
  // scoreProvenance (BRO-6052): 'page-parsed' ONLY, on a body-less file an LLM method label
  // (llm-v6, anchored-v6) relabelled before BRO-5055. The label hid that the star was read off the
  // outlet's own page, so the rebuild treats it as aggregator-relayed and drops it. The plan's
  // description must name the pre-relabel scoreSource recovered from review-texts history.
  'scoreProvenance',
  // outletId (BRO-5289): relabel to 'ap' on a file whose url is an AP wire page on a partner
  // newspaper's host (online.wsj.com/article/AP<32 hex>.html). The text is the Associated Press's own
  // review; a rename alone is undone by the rebuild's filename-vs-outletId heal. See FIELD_VALUE_CHECKS.outletId.
  // BRO-5995: or to the registry outlet the record's own `outlet` label names, never to a higher tier.
  'outletId',
];

// True when a record's syndication pointer names the record's own file
// ("<folder>/<file>" or a bare "<file>"). ctx.folder and ctx.file come from
// the on-disk path, so a plan cannot claim a pointer is stale.
function isSelfSyndicationPointer(record, ctx = {}) {
  const ptr = record && record.syndicatedPrimaryFile;
  if (typeof ptr !== 'string' || !ctx.folder || !ctx.file) return false;
  return ptr === `${ctx.folder}/${ctx.file}` || ptr === ctx.file;
}

const compactLabel = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/gi, '').toLowerCase();

// BRO-5995: relabel a file to the registry outlet its own stored `outlet` label already names
// (Star 102 Cleveland filed under cleveland-plain-dealer while outlet reads "Cleveland's Star 102").
// `outlet` is not an editable field, so a plan cannot set the label and then relabel to match it.
// A relabel never promotes a review to a higher tier than the outlet it leaves.
function storedLabelRelabelError(target, record) {
  const entry = require('./review-normalization').loadOutletRegistry();
  const out = entry && entry.outlets && entry.outlets[target];
  if (!out) return `outletId: ${target} is not in the outlet registry (only 'ap', or the outlet the record's own label names, may be set)`;
  const label = compactLabel(record.outlet);
  const names = [out.displayName, ...(Array.isArray(out.aliases) ? out.aliases : [])].map(compactLabel).filter(Boolean);
  if (!label || !names.includes(label)) return `outletId: record label "${record.outlet || ''}" does not name ${target}`;
  const { getTier } = require('./outlet-tiers');
  if (getTier(target) < getTier(record.outletId)) return `outletId: relabel to ${target} would raise the review's tier`;
  return null;
}

// Per-field value checks beyond "scalar". Returns an error string or null.
const FIELD_VALUE_CHECKS = {
  crossOutletVerifiedNote: (v) => (typeof v === 'string' && v.trim().length >= 20
    ? null : 'crossOutletVerifiedNote must record the checked byline evidence (20+ chars)'),
  crossOutletVerified: (v, record) => (v === true && record.wrongAttribution !== true
    && typeof record.crossOutletVerifiedNote === 'string' && record.crossOutletVerifiedNote.trim().length >= 20
    ? null : 'crossOutletVerified may only be set true after an evidence note, with no wrongAttribution flag'),
  outletId: (v, record) => {
    if (v === 'ap') {
      const { AP_WIRE_URL } = require('./ap-wire-detect');
      let pathname = null;
      try { pathname = new URL(record.url).pathname; } catch { /* not a url */ }
      if (!pathname || !AP_WIRE_URL.test(pathname)) return 'outletId: relabel to ap needs an AP wire url (/article/AP<32 hex>) on the record';
      return null;
    }
    return storedLabelRelabelError(v, record);
  },
  allowCrossMarket: (v) => (v === true ? null : 'allowCrossMarket may only be set to true'),
  fabricatedEntry: (v) => (v === false ? null : 'fabricatedEntry may only be cleared (false)'),
  // BRO-4415: or when the executor's syndicated-duplicate-heal decision (ctx.syndicatedHeal) is 'clear':
  // the primary is excluded for a reason that does not apply to this copy.
  isSyndicatedDuplicate: (v, record, ctx = {}) => (v === false && (isSelfSyndicationPointer(record, ctx) || ctx.syndicatedHeal === true || ctx.syndicatedDanglingClear === true)
    ? null : 'isSyndicatedDuplicate may only be cleared (false), and only when syndicatedPrimaryFile points at this same file or its primary is excluded for a primary-only reason (syndicated-duplicate-heal)'),
  // BRO-5396: a pointer whose primary file is gone is cleared when no live copy of the article exists
  // (ctx.syndicatedDanglingClear), or repointed to the live same-show copy the executor found (ctx.syndicatedRepointTo).
  syndicatedPrimaryFile: (v, record, ctx = {}) => (((v === null && (isSelfSyndicationPointer(record, ctx) || ctx.syndicatedHeal === true || ctx.syndicatedDanglingClear === true))
    || (typeof v === 'string' && ctx.syndicatedRepointTo && v === `${ctx.folder}/${ctx.syndicatedRepointTo}`))
    ? null : 'syndicatedPrimaryFile may only be cleared (null) when it points at this same file, its primary is excluded for a primary-only reason, or its primary file is gone with no live copy; or repointed to the live same-show copy of a gone primary'),
  isRoundupArticle: (v) => (v === false ? null : 'isRoundupArticle may only be cleared (false)'),
  crossOutletDuplicate: (v) => (v === false ? null : 'crossOutletDuplicate may only be cleared (false)'),
  isNotReview: (v, record) => (v === false && record.isNotReviewManualClear === true
    ? null : 'isNotReview may only be cleared (false), after isNotReviewManualClear is set'),
  isNotReviewReason: (v) => (v === null ? null : 'isNotReviewReason may only be cleared (null)'),
  nonReviewFlag: (v, record) => (v === false && record.nonReviewManualClear === true
    ? null : 'nonReviewFlag may only be cleared (false), after nonReviewManualClear is set'),
  showNotMentionedManualClear: (v) => (typeof v === 'string' && v.trim().length >= 20
    ? null : 'showNotMentionedManualClear must say what was checked (20+ chars)'),
  // BRO-5420: isNonReviewDemotedByFreshCV ignores an isNonReview flag when a
  // newer high-confidence CV calls the article a review, unless the flag is
  // marked manual. A plan's flag is a human decision, so setting it true needs
  // the manual marker on isNonReviewReason first; without it the flag sat on
  // disk while the review stayed live (brighton-beach-memoirs-2009 LA Times).
  isNonReview: (v, record) => (v !== true
    || (typeof record.isNonReviewReason === 'string' && /^manual \(not a review\)/i.test(record.isNonReviewReason))
    ? null : 'isNonReview may only be set true after isNonReviewReason starts "manual (not a review)" (a plan flag is a human decision; otherwise a fresh CV demotes it)'),
  showNotMentioned: (v, record) => (v === false && typeof record.showNotMentionedManualClear === 'string' && record.showNotMentionedManualClear.trim()
    ? null : 'showNotMentioned may only be cleared (false), after showNotMentionedManualClear records the check'),
  // BRO-6640: every reader tests `=== true`; a prose value (the reason) left
  // the clear inert and let the rebuild re-promote the flag.
  wrongProductionManualClear: (v) => (typeof v === 'boolean'
    ? null : 'wrongProductionManualClear must be true or false (put the reason in the action description)'),
  crossOutletClearReason: (v) => (typeof v === 'string' && v.trim().length > 0
    ? null : 'crossOutletClearReason must be a non-empty string'),
  showId: (v, record, ctx = {}) => (typeof v === 'string' && v && ctx.folder && v === ctx.folder
    ? null : 'showId may only be set to the folder the file lives in'),
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
    // The extractor's write guard (BRO-5796): a quote it refuses would be
    // re-extracted over this edit on its next run.
    const reject = require('./pull-quote-guards').llmQuoteHardRejectReason(v, record.fullText);
    if (reject) return `llmPullQuote rejected: ${reject}`;
    return null;
  },
  // A url edit is allowed only when the CURRENT url is provably wrong for this
  // file: an aggregator/round-up page, a non-review page (show page, cast
  // announcement), or another named critic's review a sibling file already
  // holds (ctx.currentUrlOwnedByOtherCritic, computed by the executor), or a
  // url naming another show whose folder already holds it
  // (ctx.currentUrlOwnedByOtherShow, BRO-3065).
  // The new value must be a review-candidate url on this outlet's own domain,
  // or '' (only when the current url is an aggregator page: a Theatre Record
  // text is stored with no url, and '' restores that shape without clearing
  // the text, since '' is not a url change for url-change-invariant).
  url: (v, record, ctx = {}) => {
    const { isAggregatorPageUrl } = require('./review-slot-guards');
    const { classifyReviewUrl, listingPageUrlReason } = require('./non-review-url-patterns');
    const current = record.url || '';
    const currentAggregator = isAggregatorPageUrl(current);
    // BRO-5183: a legacy web-search row the scorer already excludes for want of
    // page text holds a url that step made up (outlet 404 pages, patterned
    // Washington Post GUIDs). Nothing ever vouched for it, so it may be repaired
    // to the review's real url; the collector then refetches and verifies it.
    const { isUnverifiableWebSearchRow, isLegacyWebSearchOnly } = require('./review-guards');
    const unverifiedSearchUrl = isLegacyWebSearchOnly(record) && isUnverifiableWebSearchRow(record);
    const currentWrong = currentAggregator
      || (current && classifyReviewUrl(current).ok === false)
      // A tag / category / author index (theatermania.com/tags/<show>/): the
      // rebuild already drops a row on it (rebuild-all-reviews.js listingPageUrlReason),
      // but classifyReviewUrl does not list it, so a file auto-pinned onto one
      // could never be repaired (A Ghost in Your Ear / TheaterMania, BRO-5557).
      || (current && !!listingPageUrlReason(current))
      || ctx.currentUrlOwnedByOtherCritic === true
      || ctx.currentUrlOwnedByOtherShow === true
      || unverifiedSearchUrl;
    if (!currentWrong) return 'url: the current url is not provably wrong (aggregator, non-review page, another critic\'s review, another show\'s review, or an unverified legacy web-search url)';
    if (v === '') {
      // BRO-5374: '' keeps the text (it is not a url change for the invariant).
      // Allowed for an aggregator url, a url that is not a url at all, or a
      // provably wrong url on a Theatre Record print row, whose text never came
      // from that url. Never over a human url lock.
      if ((record.urlVerified === true && !record.urlVerifiedAuto) || record.urlManualOverride) {
        return 'url: the current url carries a human lock (urlVerified/urlManualOverride)';
      }
      const garbage = current && ['not-http-url', 'unparseable-url'].includes(classifyReviewUrl(current).reason);
      const printRow = record.source === 'theatre-record' || !!record.theatreRecordUrl;
      return currentAggregator || garbage || printRow
        ? null : 'url: clearing to "" is only for an aggregator url, a malformed url, or a wrong url on a Theatre Record print row';
    }
    if (typeof v !== 'string' || !/^https?:\/\//i.test(v)) return 'url must be an http(s) url or ""';
    if (!classifyReviewUrl(v).ok || isAggregatorPageUrl(v)) return 'url: new value is not a review-candidate url';
    const { isCrossOutletUrl } = require('./review-normalization');
    if (record.outletId && isCrossOutletUrl(record.outletId, v) && !splitRelabelUndo(record, v)) return `url: new value belongs to another outlet than ${record.outletId}`;
    return null;
  },
  aggregatorStars: (v, record) => {
    if (v !== null) return 'aggregatorStars: a plan may only clear it (newValue must be null)';
    return record && record.aggregatorStarsSource
      ? 'aggregatorStars: carries an aggregatorStarsSource (stars read from a page); only sourceless stars may be cleared'
      : null;
  },
  scoreProvenance: (v, record) => {
    if (v !== 'page-parsed') return "scoreProvenance: a plan may only write 'page-parsed'";
    if (record.scoreProvenance) return 'scoreProvenance: already stamped';
    if (typeof record.fullText === 'string' && record.fullText.trim().length >= 200) return 'scoreProvenance: the file has a body, provenance only matters for body-less files';
    if (!(record.aggregatorStars || record.originalScore != null || typeof record.originalScoreNormalized === 'number')) return 'scoreProvenance: the file carries no star or score';
    const { AGGREGATOR_SCORE_SOURCES } = require('./review-normalization');
    const relay = [record.originalScoreSource, record.aggregatorStarsSource].find((x) => x && (AGGREGATOR_SCORE_SOURCES.has(x) || x === 'theatre-reviews' || x === 'lbo-roundup'));
    if (relay) return `scoreProvenance: the score carries an aggregator source (${relay}), so it is not page-parsed`;
    // Only a fetch that failed for a known access reason leaves the page-read star trustworthy; any content verdict (wrong_content, url_content_mismatch, scraper_garbage, roundup_only, no_url, url_dead) says the page was not this review.
    if (record.incompleteReason && !/^(paywall|timeout|fetch_timeout|scraper_timeout)$/.test(record.incompleteReason)) return `scoreProvenance: incompleteReason ${record.incompleteReason} means the page the star came from may not be this review`;
    return /^(llm-v\d+|anchored-v\d+|manual-cleared-haiku-fallback)$/.test(record.scoreSource || '')
      ? null : 'scoreProvenance: only a file whose scoreSource is an LLM method label (the BRO-5055 relabel) may be stamped';
  },
  // Excerpts: clear only (BRO-4251). Text written by a plan would bypass the
  // scraper's provenance; a wrong excerpt is removed, never rewritten.
  ...Object.fromEntries(EXCERPT_FIELDS.map((f) => [f, (v) => (v === null
    ? null : `${f}: a plan may only clear an excerpt (newValue must be null)`)])),
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

// BRO-5356: the rule lives in stale-wrong-content-tier.js (shared with safeWriteReview).
function retierAfterFlagClear(record) {
  return require('./stale-wrong-content-tier').retierStaleWrongContentTier(record);
}

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
  if (field === 'crossOutletDuplicate' && newValue === false && !record.crossOutletClearReason) {
    return { ok: false, reason: 'clearing crossOutletDuplicate needs a crossOutletClearReason edit first' };
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
    else {
      guard.invalidateWrongShowAutoClear(next);
      // BRO-4599: same as BRO-5000 for a script-made wrongShowOverride.
      const sc = guard.retractScriptWrongShowClear(next);
      if (sc.blockedByManualClear) {
        return { ok: false, reason: 'wrongShow: record carries wrongShowManualClear or a non-script wrongShowOverride; a flag plan will not overrule it' };
      }
      // The rebuild gate (wrongShowCleared) also honors wrongProduction clears.
      // Refuse rather than report a flag that changes nothing.
      if (require('./review-guards').wrongShowCleared(next)) {
        return { ok: false, reason: 'wrongShow: a wrongProduction clear on this record still masks the flag, so it would change nothing' };
      }
    }
    sideEffectKeys = unexpectedChanges(beforeRetract, next, field);
  }
  // BRO-5280: an approved flag outranks the clear breadcrumbs the self-clear
  // audit pairs with it (wrongAttribution vs crossOutletVerified /
  // wrongArticleManualClear). Left in place, the record says both "wrong" and
  // "cleared" and audit-self-contradictory-clears fails Data Validation.
  if (newValue === true) {
    const fc = require('./flag-contradiction');
    const beforeRetract = { ...next };
    const pairs = fc.SELF_CLEAR_PAIRS.filter((p) => p.flag === field
      && (p.resolution || 'retract-breadcrumb') === 'retract-breadcrumb'
      && fc.hasClearBreadcrumbValue(next[p.breadcrumb]));
    if (pairs.some((p) => p.breadcrumb === 'wrongArticleManualClear')) {
      // Manual ingest stamps this with humanReviewedWrongArticle:false and
      // nonReviewManualClear (manual-review-fields.js): a human verdict, which
      // a flag plan must not overrule (same rule as BRO-5000 above). It also
      // clears wrongFullText, so retracting it would revive that flag unasked.
      if (next.humanReviewedWrongArticle === false || next.nonReviewManualClear === true) {
        return { ok: false, reason: `${field}: record carries a human wrong-article clear (manual ingest); a flag plan will not overrule it` };
      }
      if (next.wrongFullText === true) {
        return { ok: false, reason: `${field}: wrongArticleManualClear also clears a live wrongFullText; retracting it would revive that flag` };
      }
    }
    for (const pair of pairs) {
      fc.retractStaleClearBreadcrumb(next, { ...pair, task: `approved fix ${stamp.fixId}` });
      // The note explains the clear; with the clear gone it only misleads
      // (fix-cross-outlet-attributions.js drops it the same way).
      if (pair.breadcrumb === 'crossOutletVerified') delete next.crossOutletVerifiedNote;
    }
    sideEffectKeys = [...new Set([...sideEffectKeys, ...unexpectedChanges(beforeRetract, next, field)])].sort();
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
  if (field === 'outletId') {
    // Display name and breadcrumb travel with the id (the outlet-split relabel stamps the same pair).
    next.outlet = require('./review-normalization').getOutletDisplayName(newValue) || newValue;
    next.outletIdCorrectedFrom = record.outletId || null;
    // The AP detector flags AP copy under another outlet as a syndicated duplicate (detect-syndicated-duplicates.js);
    // on the AP row itself that stamp would exclude the review the relabel exists to recover.
    if (newValue === 'ap' && record._apContentDetected === true && record.isSyndicatedDuplicate === true) {
      next.isSyndicatedDuplicate = false;
      next.syndicatedPrimaryFile = null;
      next._apContentDetected = false;
    }
    next.outletIdCorrectedReason = newValue === 'ap'
      ? `approved fix ${stamp.fixId}: AP wire page ${record.url} is the Associated Press's review, not ${record.outletId || 'another outlet'}'s`
      : `approved fix ${stamp.fixId}: the record's own outlet label "${record.outlet}" names ${newValue}, not ${record.outletId || 'another outlet'}`;
  }
  if (field === 'originalScore') {
    // The helper owns the whole rating write, so it starts from the stored value.
    next.originalScore = record.originalScore === undefined ? null : record.originalScore;
    const beforeRating = { ...next };
    const r = require('./verified-original-score').applyVerifiedOriginalScore(next, newValue, `approved fix ${stamp.fixId}: rating verified against the outlet page`);
    if (!r.ok) return { ok: false, reason: r.reason };
    sideEffectKeys = unexpectedChanges(beforeRating, next, field);
  }
  if (field === 'aggregatorStars') {
    // The stars were the score's anchor: queue a rescore through the normal path, the same way
    // the wrong-show round-up star removal does (aggregator-page-show-guard).
    const beforeRescore = { ...next };
    require('./rescore-flagging').markRescoreNeeded(next, `approved fix ${stamp.fixId}: sourceless aggregatorStars cleared`, undefined, { requeue: true });
    delete next.rescoreCompletedAt;
    sideEffectKeys = [...new Set([...sideEffectKeys, ...unexpectedChanges(beforeRescore, next, field)])].sort();
  }
  const prior = Array.isArray(record.approvedFixes) ? record.approvedFixes : [];
  const stampEntry = { fixId: stamp.fixId, field, at: stamp.at, newValue };
  // A verdict that sets a flag binds to the url + body it was made on (BRO-6676).
  // Hashed on `next` so the edit's own retractions are part of the judged state.
  if (newValue === true) stampEntry.boundTo = require('./approved-fix-flag').approvedFixBinding(next);
  next.approvedFixes = [...prior, stampEntry];
  if ((field === 'wrongShow' || field === 'wrongProduction') && newValue === false) {
    const retiered = retierAfterFlagClear(next);
    if (retiered.length) sideEffectKeys = [...new Set([...sideEffectKeys, ...retiered])].sort();
  }
  const retractMsg = sideEffectKeys.length ? ` (retracted ${sideEffectKeys.join(', ')})` : '';
  return { ok: true, record: next, sideEffectKeys, msg: `${field}: ${JSON.stringify(expected)} -> ${JSON.stringify(newValue)}${retractMsg}` };
}

// Moved to approved-fix-flag.js (write-free); re-exported below for callers.
const { hasApprovedFlag } = require('./approved-fix-flag');

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
  if (field === 'outletId') for (const k of ['outlet', 'outletIdCorrectedFrom', 'outletIdCorrectedReason', 'isSyndicatedDuplicate', 'syndicatedPrimaryFile', '_apContentDetected']) expected.add(k);
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
    // An explicit new duplicate verdict retracts the legacy collision clear.
    // The guard already performs this when that sibling owns the same URL.
    if (before.duplicateOf !== after.duplicateOf && after._duplicateOfCleared == null) {
      expected.add('_duplicateOfCleared');
    }
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
/**
 * Excerpt fields the write guard's cloned-excerpt rule would strip from this
 * record, given its same-folder siblings on disk (same call the guard makes).
 * @returns {string[]}
 */
function predictedExcerptStrips(abs, record) {
  const fs = require('fs');
  const path = require('path');
  const guard = require('./cloned-excerpt-guard');
  if (guard.excerptValues(record).size === 0) return [];
  const dir = path.dirname(abs);
  const self = path.basename(abs);
  const siblings = [];
  for (const f of fs.readdirSync(dir)) {
    if (!isReviewTextFile(f) || f === self) continue;
    try { siblings.push({ file: f, data: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }); } catch { /* unreadable sibling */ }
  }
  return guard.excerptFieldsToStrip(self, record, siblings).fields;
}

/**
 * BRO-4415: would syndicated-duplicate-heal clear this record's mark? Judged on the record as a marked secondary, so the
 * second action of a pair (pointer after flag, or the reverse) is still recognised. 'keep' on any problem (no shows.json).
 */
function syndicatedHealDecision(reviewTextsDir, ctx, record) {
  const fs = require('fs');
  const path = require('path');
  try {
    const showsPath = path.join(__dirname, '..', '..', 'data', 'shows.json');
    const shows = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
    const show = (Array.isArray(shows) ? shows : shows.shows).find((s) => s.id === ctx.folder);
    if (!show) return 'keep';
    const dir = path.join(reviewTextsDir, ctx.folder);
    const { explainExclusion } = require('./review-guards');
    const { syndicatedDuplicateHealPlan } = require('./syndicated-duplicate-heal');
    const plan = syndicatedDuplicateHealPlan({
      data: { ...record, isSyndicatedDuplicate: true },
      file: ctx.file,
      folder: ctx.folder,
      io: { exists: (f) => fs.existsSync(path.join(dir, f)), read: (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) },
      explain: (d, f) => explainExclusion(d, show, path.join(dir, f)),
    });
    return plan ? plan.decision : 'keep';
  } catch { return 'keep'; }
}

/**
 * BRO-5396: the pointer's primary file is gone. Returns {syndicatedRepointTo} (a live same-show copy holds the
 * article) or {syndicatedDanglingClear: true} (none does, so the secondary is the only copy). {} when the pointer
 * resolves to an existing file.
 */
function isApWireUrl(url) {
  try { return require('./ap-wire-detect').AP_WIRE_URL.test(new URL(url).pathname); } catch { return false; }
}

function syndicatedDanglingContext(reviewTextsDir, ctx, record) {
  const fs = require('fs');
  const path = require('path');
  try {
    const ptr = record.syndicatedPrimaryFile;
    const slash = ptr.indexOf('/');
    const ptrFolder = slash >= 0 ? ptr.slice(0, slash) : ctx.folder;
    if (fs.existsSync(path.join(reviewTextsDir, ptrFolder, path.basename(ptr)))) return {};
    const dir = path.join(reviewTextsDir, ctx.folder);
    const { findLiveSyndicationPrimary } = require('./syndicated-duplicate-heal');
    const found = findLiveSyndicationPrimary({
      data: record, file: ctx.file, siblings: fs.readdirSync(dir),
      read: (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')),
    });
    if (found.undecidable) return {}; // could not tell whether a live copy exists: refuse to clear
    const live = found.file;
    return live ? { syndicatedRepointTo: live } : { syndicatedDanglingClear: true };
  } catch { return {}; }
}

function executeReviewFieldEditIn(reviewTextsDir, action, stamp) {
  const fs = require('fs');
  const path = require('path');
  const abs = resolveReviewPath(reviewTextsDir, action.file);
  if (!abs) return { ok: false, reason: `Bad review path: ${action.file}` };
  if (!fs.existsSync(abs)) return { ok: false, reason: `Review file not found: ${action.file}` };
  const record = JSON.parse(fs.readFileSync(abs, 'utf8'));
  // url edits (BRO-4430) may repair a url that a sibling file holds for a
  // different named critic; that needs the show dir, so it is computed here.
  const ctx = { folder: path.basename(path.dirname(abs)), file: path.basename(abs) };
  if (action.field === 'url' && record.url) {
    const { urlOwnedByOtherCritic } = require('./review-slot-guards');
    ctx.currentUrlOwnedByOtherCritic = !!urlOwnedByOtherCritic({
      showDir: path.dirname(abs), url: record.url,
      selfFilename: path.basename(abs), selfCriticName: record.criticName,
    });
    if (!ctx.currentUrlOwnedByOtherCritic) {
      const { urlOwnedByOtherShow } = require('./review-slot-guards');
      ctx.currentUrlOwnedByOtherShow = !!urlOwnedByOtherShow({
        reviewTextsDir, folder: ctx.folder, url: record.url, publishDate: record.publishDate,
      });
    }
  }
  if ((action.field === 'isSyndicatedDuplicate' || action.field === 'syndicatedPrimaryFile')
      && typeof record.syndicatedPrimaryFile === 'string' && !isSelfSyndicationPointer(record, ctx)) {
    ctx.syndicatedHeal = syndicatedHealDecision(reviewTextsDir, ctx, record) === 'clear';
    // The AP scan never flags ap-- files itself (detect-syndicated-duplicates.js skips them), so on an AP-outlet row
    // with an AP wire url the stamp is a leftover from when the page was filed under another outlet (BRO-5289).
    if (!ctx.syndicatedHeal && record.outletId === 'ap' && record._apContentDetected === true && isApWireUrl(record.url)) ctx.syndicatedHeal = true;
    Object.assign(ctx, syndicatedDanglingContext(reviewTextsDir, ctx, record));
  }
  const res = applyReviewFieldEdit(record, action, stamp, ctx);
  if (!res.ok) return res;
  // A copy: the guard restores protected fields by mutating what it is handed, which would hide a revert below.
  // The compare-and-set above proves this clear is fresh, even when a prior
  // attempt already stamped its breadcrumb. Only the requested field may
  // bypass that stale-payload check; collision and lock guards still run.
  const writeOptions = action.field === 'url' ? { approvedUrlRepair: true } : {};
  if (action.field === 'duplicateOf' && action.newValue === null) {
    writeOptions.approvedFieldClear = action.field;
  }
  // BRO-5295: a rating re-added to a record that was ALREADY cleared (the Her Campus 2/5 came back the day after
  // its clear) is removed the same way. The guard widens the scope to the derived rating fields.
  if (action.field === 'originalScore' && action.newValue === null && record.originalScoreCleared === true) {
    writeOptions.approvedFieldClear = action.field;
  }
  require('./review-write-guard').safeWriteReview(abs, { ...res.record }, writeOptions);
  // The write guard can legitimately refuse a change (a protected field with
  // no clear breadcrumb). Report that instead of claiming success.
  const after = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const got = after[action.field] === undefined ? null : after[action.field];
  if (JSON.stringify(got) !== JSON.stringify(action.newValue)) {
    return { ok: false, reason: `${action.file} ${action.field}: write guard kept ${JSON.stringify(got)}` };
  }
  // A flag the rebuild still reads as cleared changes nothing (BRO-4599).
  if (action.field === 'wrongShow' && action.newValue === true && require('./review-guards').wrongShowCleared(after)) {
    return { ok: false, reason: `${action.file} wrongShow: written, but a clear on the record still masks it` };
  }
  // Side effects the edit made itself (BRO-4849: the derived rating fields) must
  // survive the write too, or a half-written rating would report success.
  const lost = (res.sideEffectKeys || []).filter((k) => JSON.stringify(after[k] ?? null) !== JSON.stringify(res.record[k] ?? null));
  if (lost.length) {
    return { ok: false, reason: `${action.file} ${action.field}: write guard reverted ${lost.join(', ')}` };
  }
  // BRO-5232: the write guard strips an aggregator excerpt a same-outlet sibling
  // provably owns (cloned-excerpt-guard, BRO-4406) on ANY write, so a byline or
  // verdict fix on a phantom row (king-lear-2019 guardian--jesse-green) always
  // nulled its cloned dtli/showScore excerpts and was refused here. Expect
  // exactly the fields the guard's own rule names for this record, and only as
  // nulled; any other change still refuses.
  const stripped = predictedExcerptStrips(abs, res.record).filter((k) => record[k] != null && after[k] == null);
  const extra = unexpectedChanges(record, after, action.field, [...(res.sideEffectKeys || []), ...stripped]);
  if (extra.length) {
    return { ok: false, reason: `${action.file} ${action.field} applied, but the write guard also changed ${extra.join(', ')}; check the record before trusting it` };
  }
  const note = stripped.length ? ` (write guard stripped cloned ${stripped.join(', ')})` : '';
  return { ok: true, msg: `${action.file} ${res.msg}${note}` };
}

module.exports = {
  retierAfterFlagClear, REVIEW_TEXT_EDITABLE_FIELDS, applyReviewFieldEdit, resolveReviewPath, unexpectedChanges, executeReviewFieldEditIn, hasApprovedFlag, isSelfSyndicationPointer };
