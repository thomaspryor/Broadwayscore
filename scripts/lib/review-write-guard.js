/**
 * Review Write Guard
 *
 * Prevents accidental destruction of scored/collected review data.
 * Any script that writes review JSON files should use safeWriteReview()
 * instead of raw fs.writeFileSync().
 *
 * Protected fields: assignedScore, llmScore, fullText, contentTier,
 * contentVerification, ensembleData, llmMetadata.
 *
 * Rules:
 * - If an existing file has a scored field and the new data doesn't,
 *   the scored field is preserved from the existing file.
 * - Set force=true to bypass (for intentional score clearing like rescoring).
 *
 * Used by:
 * - scripts/sweep-we-aggregators.js
 * - scripts/lib/review-file-writer.js (createOrMergeReviewFile, writeManualReview)
 * - scripts/ingest-manual-review.js (via review-file-writer)
 * - Any future script that writes to data/review-texts/
 *
 * URL-change invariant (Notion 399637c5): safeWriteReview() and
 * review-normalization.js mergeReviews() both enforce, via
 * lib/url-change-invariant.js, that a write moving a file's url to a different
 * canonical article clears old-URL-derived state (flags, excerpts, stars,
 * scores, text) and records a durable `_urlChangedClear` breadcrumb that
 * isIntentionalClear() honors so rebase-restores don't resurrect it.
 *
 * NOT used by (bespoke preservation, keep in sync with PROTECTED_FIELDS):
 * - scripts/gather-reviews.js URL-replacement path (line ~3101). Imports
 *   PROTECTED_FIELDS and intersects with REPLACE_CLEAR_FIELDS to derive its
 *   own preserve list. If you add a field here that should be cleared on
 *   URL replacement, also add it to REPLACE_CLEAR_FIELDS there.
 * - scripts/collect-review-texts.js terminal-state gate updates (intentional
 *   narrow patches that don't touch PROTECTED_FIELDS; see Notion P1 card).
 */

const fs = require('fs');
const path = require('path');
const { parseRating } = require('./score-conversion-rules');
const { validateTemporalAttribution } = require('./temporal-byline-guard');
const { wouldFormDuplicateCycle: _wouldFormDuplicateCycleN } = require('./duplicate-cycle');
const { shouldFlipDuplicateDirection } = require('./duplicate-direction-heal');

// Lazy-loaded, memoized once per process — safeWriteReview is called
// thousands of times per rebuild run and shows.json rarely changes mid-run.
let _showsByIdCache = null;
let _siblingOpeningsCache = null;
function _getShowById(showId) {
  if (!_showsByIdCache) {
    _showsByIdCache = new Map();
    try {
      const repoRoot = path.resolve(__dirname, '..', '..');
      const parsed = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data', 'shows.json'), 'utf-8'));
      const shows = Array.isArray(parsed) ? parsed : (parsed.shows || []);
      for (const s of shows) { if (s && s.id) _showsByIdCache.set(s.id, s); }
    } catch { /* leave cache empty — guard below just no-ops */ }
  }
  return _showsByIdCache.get(showId) || null;
}

// Same-title sibling openings for the cross-market quarantine below. Derived
// from the SAME shows map _getShowById populates, so a test that seeds the
// cache seeds both. Built once per process — buildSiblingOpeningsMap is O(shows)
// and safeWriteReview runs thousands of times per rebuild.
function _getSiblingOpenings(showId) {
  _getShowById(showId); // ensure _showsByIdCache is populated
  if (!_siblingOpeningsCache) {
    const { buildSiblingOpeningsMap } = require('./cross-market-contamination');
    _siblingOpeningsCache = buildSiblingOpeningsMap(
      [..._showsByIdCache.values()],
      (d) => (d ? new Date(d) : null)
    );
  }
  return _siblingOpeningsCache.get(showId) || [];
}

// Test-only: seed the shows cache directly so date-plausibility.test.mjs can
// exercise safeWriteReview's quarantine routing without depending on the real
// data/shows.json corpus.
function _setShowsCacheForTest(map) { _showsByIdCache = map; _siblingOpeningsCache = null; }

// Fields that represent collected/scored data and must not be silently erased.
// KEEP IN SYNC with .github/actions/push-review-texts/action.yml PROTECTED array.
const PROTECTED_FIELDS = [
  'assignedScore',
  'crossOutletVerified',
  // Audit-trail fields for the crossOutlet triage (audit-cross-outlet-
  // attributions.js / fix-cross-outlet-attributions*.js). The boolean flags
  // (crossOutletVerified, wrongAttribution below) were already protected,
  // but the notes/rename-history weren't — a rebase could silently drop WHY
  // a file was verified/renamed while the flag itself survived, defeating
  // the undo/audit trail (ship-check adversarial finding, task #991).
  'crossOutletVerifiedNote',
  'crossOutletOriginalCritic',
  'crossOutletOriginalOutletId',
  'humanReviewScore',
  'adjudicatedScore',
  'adjudicationNote',
  'manualContentTier',
  'originalScore',
  'originalScoreSource',
  'originalScoreNormalized',
  'llmScore',
  'llmMetadata',
  'fullText',
  'contentTier',
  'contentTierReason',
  'contentVerification',
  'ensembleData',
  'tierReason',
  'showTitle',
  'textFetchedAt',
  'textWordCount',
  'textStatus',
  'sourceMethod',
  'isFullReview',
  'wrongFullText',
  'wrongShow',
  'wrongShowReason',
  'wrongProduction',
  'wrongProductionNote',
  'originalScoreCleared',
  'originalScoreClearedReason',
  'previousOriginalScore',
  'humanReviewNote',
  'humanReviewedWrongProduction',
  'humanReviewedWrongArticle',
  'wrongProductionManualClear',
  'wrongArticleManualClear',
  'wrongShowManualClear',
  'wrongProductionOverride',
  'wrongProductionOverrideReason',
  'wrongProductionOverrideSetAt',
  'wrongProductionOverrideSetBy',
  'wrongShowOverride',
  'wrongShowOverrideReason',
  'wrongShowOverrideAt',
  'wrongShowNote',
  'wrongShowAutoCleared',
  'wrongShowAutoClearedAt',
  'wrongProductionAutoCleared',
  'wrongProductionAutoClearedAt',
  'wrongProductionReason',
  // When the *Reason fields were STAMPED. Every sibling *At above is protected;
  // these two were not, so the timestamp on an audit-asserted flag was silently
  // dropped by the push-time restore on the next rebase while the flag itself
  // survived — leaving a protected flag with no provenance date, which is what
  // the wrongProduction provenance lint (task #1109) exists to prevent.
  // Written by scripts/audit-wrongshow-autoclear-conflicts.js --fix
  // (ship-check finding, 2026-08-09).
  'wrongShowReasonAt',
  'wrongProductionReasonAt',
  // rediscover-review-urls.js breadcrumb: prior wrong-flag values recorded when a
  // URL is rediscovered and the flags are deleted for re-scrape. Protected so the
  // intentional-clear signal (CLEAR_BREADCRUMBS) survives a rebase rather than
  // being lost, which would let the restore resurrect the stale flag.
  '_previousWrongFlags',
  // url-change-invariant.js breadcrumb: fields cleared because the file's url
  // moved to a different canonical article (Notion 399637c5). Same rationale as
  // _previousWrongFlags — isIntentionalClear() keys on it, so losing it on a
  // rebase would let the restore resurrect old-URL-derived flags/scores.
  '_urlChangedClear',
  'wrongAttribution',
  'wrongAttributionReason',
  'manualContentTier',
  'designation',
  'isCriticsPick',
  'duplicateOf',
  'duplicateReason',
  // Task #1256 — duplicate-of-flagged-twin inheritance breadcrumb. A human
  // (or self-heal script) verified this file's content is genuinely distinct
  // from its duplicateOf sibling's content-wrongness flag (wrongShow/
  // wrongProduction/isNonReview), so scripts/lib/review-guards.js's
  // duplicateOfInheritedFlag() should NOT propagate that flag onto this
  // file. Same failure mode as duplicateClearReason above (PROTECTED_FIELDS
  // comment): an unprotected breadcrumb gets silently dropped on rebase and
  // resurrects the exclusion on a genuinely-cleared file.
  'duplicateOfFlagInheritanceCleared',
  'publishDateVerified',
  'publishDateSource',
  // Opening-night manual-ingest overrides — rebuild guards read these to bypass
  // date, market, tour, film, and routing flags. Missing from this list means
  // a CI push that rebases our commits silently drops them and the review
  // gets re-flagged on the next rebuild. See Beaches 2026-04-22 postmortem.
  'allowEarlyDate',
  'allowLateDate',
  'allowCrossMarket',
  'allowTourSignal',
  'allowTourSignalReason',
  'allowFilmSignal',
  'routedFromShowId',
  'urlVerified',
  'urlManualOverride',
  'urlManualOverrideNote',
  // Additional override flags added in Rocky Horror 2026-04-23 postmortem (Session 2 #7):
  // losing any of these on rebase silently re-flags a manually-verified review.
  'humanReviewedTour',
  'humanReviewScoreProvisional',
  'humanReviewScoreClearedForLlm',
  'isTourReview',
  'isLikelyTourReview',
  // Aggregator thumb signals used by P2 thumb-validated-LLM path in getBestScore.
  // Losing these drops low-conf LLM reviews that would otherwise ship.
  'dtliThumb',
  'bwwThumb',
  // SERP retry state — set by collect-review-texts.js + gather-reviews.js lifecycle guard.
  // Losing these on rebase causes the cooldown to reset, which means a single
  // rebase can re-trigger 13K stuck wrong_content files. See sprint-plan-serp-cost-reduction.md S1-T1.
  // NOTE: serpRetryCount/serpDiscoveryAbandoned are intentionally excluded — clearFailureFlags()
  // clears them on success. serpRetryAfter is still protected (controls backoff timing).
  'serpRetryAfter',
  'wrongShowRetryAt', // existing bug fix — was silently droppable on rebase
  // Manual-clear Haiku-fallback failure state (P1 352637c5-416f-81ab). A rebase
  // conflict resolver that picks the remote/longer-text side on ties would
  // silently drop these and resurrect the infinite re-scoring credit loop the
  // whole fix exists to stop — same class of bug as serpRetryAfter above.
  'manualClearFallbackFailedAt',
  'manualClearFallbackFailureReason',
  'manualClearFallbackAttempts',
  'manualClearFallbackAbandoned',
  // Bug #10: manually-set pull quotes must survive rebuilds and LLM overrides.
  'pullQuote',
  // Lock audit-trail metadata (Lost Boys 2026-04-27 Gap #6). Set by
  // /api/admin/lock-score; surfaced on /admin/locks. Without explicit
  // protection, a rebase + rebuild round-trip would silently strip the
  // rationale + actor + timestamp, making the audit trail useless.
  'lockedReason',
  'lockedAt',
  'lockedBy',
  'lockedAcrossTier',
  'priorScoreAtLock',
  // Per-file protection array — unions with this global list in
  // getEffectiveProtectedFields(). Must self-protect so ingest-manual-review's
  // per-record locks can't be cleared by a rebase.
  'protectedFields',
  // Task #97 audit: strip-stale-single-model-scores.js --before-opening mode
  // nulls assignedScore/llmScore/llmMetadata/ensembleData to remove prior-
  // production contamination (opening-night-express.yml), stamping these two
  // breadcrumbs. Without protecting them, the SAME job's later push-review-
  // texts restore step sees committed HEAD (checked out before the strip)
  // still carrying the old score and resurrects it in the very run that
  // cleared it — silently defeating the contamination strip every time.
  // needsRescore is protected alongside so a lost stamp doesn't strand the
  // file scoreless-and-unqueued. staleScoredBeforeOpeningAt is the freshness
  // stamp the CLEAR_BREADCRUMBS predicate below gates on (codex adversarial
  // review, task #97: a bare boolean with no reset would suppress restoring
  // ANY future, unrelated score loss on this file forever).
  'staleScoredBeforeOpening',
  'staleScoredBeforeOpeningAt',
  'needsRescore',
  // Task #1237 audit (same bug class as #97 above): apply-audit-flags.js deletes
  // fullText/assignedScore/ensembleData and sets fullTextWrongAuthor=true when a
  // review's byline doesn't match its critic (contamination removal). Without
  // protecting the flag + its freshness stamp, the SAME job's later push-review-
  // texts restore step sees committed HEAD (checked out before apply-audit-flags.js
  // ran) still carrying the wrong-author fullText/score and resurrects it —
  // silently undoing the exact contamination removal this script exists to do.
  // fullTextWrongAuthorAt is the freshness stamp the CLEAR_BREADCRUMBS predicate
  // below gates on (mirrors staleScoredBeforeOpeningAt — a bare boolean with no
  // reset would suppress restoring ANY future, unrelated data loss on this file
  // forever). Reset alongside fullTextWrongAuthor by the byline-recovery paths in
  // collect-review-texts.js and backfill-theaterlife-bylines.js.
  'fullTextWrongAuthor',
  'fullTextWrongAuthorAt',
  // Task #1259 audit (same bug class as #97/#1237 above): audit-stuck-rescore-
  // flags.js --fix deletes needsRescore/rescoreReason/lateStarAnchorBand when a
  // flag is permanently stuck (the scorer would reject the file, so the flag
  // can never clear itself). It runs in the SAME enrich-reviews.yml job that
  // later calls push-review-texts — without protecting the breadcrumb + its
  // freshness stamp, that restore step sees committed HEAD (checked out before
  // the audit ran) still carrying the stuck flag and resurrects it, silently
  // undoing the exact clear the audit exists to do. stuckRescoreClearedAt is
  // the freshness stamp the CLEAR_BREADCRUMBS predicate below gates on (mirrors
  // staleScoredBeforeOpeningAt/fullTextWrongAuthorAt — a bare boolean with no
  // reset would suppress restoring ANY future, unrelated re-flag of this file
  // forever). No reset path clears it: strip-stale-single-model-scores.js is
  // the one producer that nulls needsRescore (rather than deleting it or
  // writing a real `true`), but it never runs in the SAME job as
  // audit-stuck-rescore-flags.js --fix, so it can't race this breadcrumb
  // within the freshness window this stamp is scoped to bridge — every OTHER
  // producer re-flags with a real (non-empty) `true`, which never reaches the
  // empty-field restore-suppression path this breadcrumb guards (see
  // review-write-guard test file).
  'stuckRescoreCleared',
  'stuckRescoreClearedAt',
  // rescoreReason/lateStarAnchorBand were not previously protected — nothing
  // needed to intentionally clear them until this fix. Both are cleared
  // alongside needsRescore by audit-stuck-rescore-flags.js --fix and must be
  // PROTECTED for the CLEAR_BREADCRUMBS entries above to have any effect (the
  // restore loop only iterates PROTECTED fields).
  'rescoreReason',
  'lateStarAnchorBand',
  // NOTE: incompleteReason + incompleteDetail are intentionally NOT in this list.
  // They are derived fields that rebuild re-classifies every run. Having them here
  // caused stale 'wrong_content' flags to be preserved even after collect-review-texts.js
  // fetched correct content — blocking valid reviews from reviews.json.
  // clearFailureFlags() clears them explicitly on success paths. (Pattern Card #1,
  // Notion 346637c5-416f-8154-9500-f09fd49e5a2a, 2026-04-17)
];

/**
 * Generalized intentional-clear breadcrumbs.
 *
 * Rebase-time restorers (.github/actions/push-review-texts/action.yml and
 * scripts/lib/restore-protected-fields.js) treat an empty PROTECTED field whose
 * committed/remote counterpart had content as data-loss and revert it. That is
 * correct UNLESS the empty value is a DELIBERATE clear carrying a durable
 * breadcrumb — otherwise a CI rebase silently re-flags a human-verified review.
 *
 * Originally only duplicateOf/duplicateReason had this exception (via
 * duplicateClearReason). It is the same failure mode for the manual-clear
 * families that NULL or DELETE a flag and leave a durable signal:
 * wrongProduction (manual clear / override / humanReviewedWrongProduction:false),
 * wrongShow (review-guards.js wrongShowCleared), wrong-article, originalScore
 * (originalScoreCleared, set by fix-p0-score-corruption.js), and the rediscover
 * reset (rediscover-review-urls.js deletes wrongProduction/wrongShow for re-scrape
 * and records _previousWrongFlags). Without honoring the breadcrumb, a CI rebase
 * resurrects the stale flag and re-flags the review (or makes rediscover a no-op).
 *
 * Each entry maps a PROTECTED field to a predicate over the LOCAL record that
 * returns true when an empty value is an intentional clear. The wrong-flag and
 * originalScore breadcrumb fields are themselves in PROTECTED_FIELDS, so they survive
 * a rebase. duplicateClearReason is the one exception: it is intentionally NOT
 * protected (it must stay nullable — review-write-guard nulls it when a sibling
 * becomes a live duplicate again, see ~line 351), but the action.yml push-restore
 * reads it from the SAME working tree that wrote it, so it is still reliable on
 * that path. KEEP IN SYNC with the inline copy in
 * .github/actions/push-review-texts/action.yml (it requires this module).
 *
 * The predicates MIRROR the canonical "is-cleared" semantics used for inclusion
 * (review-guards.js) — not a broader/looser set — so the restore never diverges
 * from what the rebuild itself treats as cleared. NOTE: rebuild's
 * wrongProductionAutoCleared/wrongShowAutoCleared are STRING annotations (and set
 * the flag to `false`, which is not "empty"), so they are deliberately NOT
 * treated as clear breadcrumbs here — that matches review-guards.js, which also
 * ignores them. originalScoreCleared is sticky (never reset); the trade-off is
 * acceptable because backfill-original-scores.js already skips cleared files, so
 * a legitimate re-acquire of originalScore does not flow through the restore.
 */
const _isEmptyValue = (v) => v === undefined || v === null
  || (typeof v === 'string' && v.length === 0)
  || (Array.isArray(v) && v.length === 0);

// rediscover-review-urls.js DELETES wrongProduction/wrongShow (+reasons) to force a
// fresh re-scrape of a rediscovered URL, recording the prior values in
// _previousWrongFlags. That deletion is an intentional clear — the classifiers
// re-derive the flags on the next enrich pass — but without honoring this marker
// the rebase-restore resurrects the stale flag and rediscover becomes a no-op for
// flagged reviews (the whole point being to re-scrape wrong_content). Sub-field
// precise so it only suppresses restore of a flag rediscover actually cleared.
const _rediscoveredWrongProduction = (d) =>
  !!(d._previousWrongFlags && d._previousWrongFlags.wrongProduction);
const _rediscoveredWrongShow = (d) =>
  !!(d._previousWrongFlags && d._previousWrongFlags.wrongShow);

// Canonical "human cleared wrongProduction" predicate — EXACTLY the triplet used
// by the rebuild nuclear guard (scripts/rebuild-all-reviews.js ~2041) and
// isLikelyStaleWrongProduction (scripts/lib/review-guards.js ~815). Do not add
// wrongProductionAutoCleared (string-typed, flag set false not deleted) or
// wrongProductionClearedNote (always co-occurs with ManualClear) — that would
// drift from the canonical predicate. The rediscover reset is the one non-human
// clear honored here (separate, sub-field-gated signal).
const _wrongProductionCleared = (d) =>
  d.wrongProductionManualClear === true ||
  d.wrongProductionOverride === true ||
  d.humanReviewedWrongProduction === false ||
  _rediscoveredWrongProduction(d);

// FRESH rebuild-time auto-clear breadcrumb (2026-08-04). The rebuild's
// wrongProduction self-heal passes DELETE the flag and stamp
// wrongProductionAutoCleared(+At) — but the push-time restore treated that
// deletion as data loss and resurrected the flag from HEAD in the SAME run
// ("Protected: …liamodell--liam-odell.json (wrongProduction,
// wrongProductionNote)"), making every auto-clear a no-op forever. This is a
// RESTORE-scope breadcrumb only: it is deliberately NOT added to
// _wrongProductionCleared (which mirrors the canonical is-cleared triplet used
// by scoring/guards — see comment above). Freshness-gated so a years-old stamp
// on a legitimately re-flagged file can never suppress a real data-loss
// restore: only clears stamped within the last 7 days count, and all rebuild
// clear paths stamp wrongProductionAutoClearedAt.
const AUTO_CLEAR_FRESH_DAYS = 7;

/**
 * Invalidate the auto-clear breadcrumb when a writer RE-FLAGS wrongProduction.
 * Without this, a legitimate re-flag within AUTO_CLEAR_FRESH_DAYS could be
 * suppressed by the still-fresh stamp if a stale checkout (carrying the cleared
 * state) races the push — the inverted ping-pong (ship-check 2026-08-04).
 * Every `wrongProduction = true` writer should call this.
 *
 * @param {object} d - review record being flagged (mutated in place)
 */
function invalidateWrongProductionAutoClear(d) {
  if (!d) return;
  delete d.wrongProductionAutoCleared;
  delete d.wrongProductionAutoClearedAt;
}

const _freshWrongProductionAutoClear = (d) => {
  if (!d || !d.wrongProductionAutoCleared || !d.wrongProductionAutoClearedAt) return false;
  const at = Date.parse(String(d.wrongProductionAutoClearedAt));
  if (Number.isNaN(at)) return false;
  return (Date.now() - at) <= AUTO_CLEAR_FRESH_DAYS * 86400000;
};

// staleScoredBeforeOpening freshness gate (task #97 codex adversarial review).
// Same shape as _freshWrongProductionAutoClear above but a shorter window: this
// only needs to bridge opening-night-express.yml's two same-job push-review-
// texts calls, not survive an ordinary rebuild cadence. rescore-lifecycle.js's
// markRescoreComplete() is the primary clear path (deletes both fields the
// moment a fresh score lands); this bounds the case where that path is never
// reached (e.g. the show never gets rescored) so the stamp can't suppress
// restoring a later, unrelated score loss indefinitely.
const STALE_SCORE_FRESH_DAYS = 3;
const _freshStaleScoredBeforeOpening = (d) => {
  if (!d || d.staleScoredBeforeOpening !== true || !d.staleScoredBeforeOpeningAt) return false;
  const at = Date.parse(String(d.staleScoredBeforeOpeningAt));
  if (Number.isNaN(at)) return false;
  // age >= 0 excludes future-dated stamps (malformed or clock-skewed), which
  // would otherwise pass `<= FRESH_DAYS` via a negative age and suppress
  // restoring a data-loss forever, not just for the intended window (codex
  // adversarial review, task #1237).
  const age = Date.now() - at;
  return age >= 0 && age <= STALE_SCORE_FRESH_DAYS * 86400000;
};

// fullTextWrongAuthor freshness gate (task #1237, same shape as
// _freshStaleScoredBeforeOpening above). apply-audit-flags.js is invoked by
// rebuild-reviews.yml, the same job that later calls push-review-texts twice —
// this only needs to bridge that single job run, not survive an ordinary
// rebuild cadence. The byline-recovery paths (collect-review-texts.js,
// backfill-theaterlife-bylines.js) are the primary clear path and delete both
// fields the moment a byline is corrected; this bounds the case where that
// never happens (file never re-collected) so the stamp can't suppress
// restoring a later, unrelated fullText/score loss on this file indefinitely.
const WRONG_AUTHOR_FRESH_DAYS = 3;
const _freshFullTextWrongAuthor = (d) => {
  if (!d || d.fullTextWrongAuthor !== true || !d.fullTextWrongAuthorAt) return false;
  const at = Date.parse(String(d.fullTextWrongAuthorAt));
  if (Number.isNaN(at)) return false;
  // age >= 0 excludes future-dated stamps — see _freshStaleScoredBeforeOpening.
  const age = Date.now() - at;
  return age >= 0 && age <= WRONG_AUTHOR_FRESH_DAYS * 86400000;
};

// stuckRescoreCleared freshness gate (task #1259, same shape as
// _freshStaleScoredBeforeOpening/_freshFullTextWrongAuthor above).
// audit-stuck-rescore-flags.js --fix is invoked by enrich-reviews.yml, the
// same job that later calls push-review-texts — this only needs to bridge
// that single job run, not survive an ordinary rebuild cadence. There is no
// other clear path to retire the stamp (unlike the two siblings above, which
// have a "real work landed" success path): every OTHER producer re-flags
// needsRescore with a real (non-empty) `true`, which never reaches the
// empty-field restore-suppression this breadcrumb guards. The one producer
// that nulls it instead (strip-stale-single-model-scores.js) never runs in
// the SAME job as audit-stuck-rescore-flags.js --fix, so it can't collide
// with this stamp inside the freshness window. It only ever suppresses
// restoring a genuinely-cleared, still-empty field, and expires on its own
// after STUCK_RESCORE_FRESH_DAYS regardless.
const STUCK_RESCORE_FRESH_DAYS = 3;
const _freshStuckRescoreCleared = (d) => {
  if (!d || d.stuckRescoreCleared !== true || !d.stuckRescoreClearedAt) return false;
  const at = Date.parse(String(d.stuckRescoreClearedAt));
  if (Number.isNaN(at)) return false;
  // age >= 0 excludes future-dated stamps — see _freshStaleScoredBeforeOpening.
  const age = Date.now() - at;
  return age >= 0 && age <= STUCK_RESCORE_FRESH_DAYS * 86400000;
};

// Reuse the canonical wrongShow-cleared predicate (lazy require keeps this module
// circular-safe — review-guards.js has no top-level require back to here). It
// already unions the production-level human-clear signals, which a bespoke copy
// here previously omitted. Plus the rediscover reset.
const _wrongShowCleared = (d) => {
  if (_rediscoveredWrongShow(d)) return true;
  try {
    return !!require('./review-guards').wrongShowCleared(d);
  } catch {
    // Fallback if review-guards is unavailable in a minimal env — superset of
    // the production triplet plus the wrongShow-specific manual signals.
    return d.wrongShowManualClear === true || d.wrongShowOverride === true
      || _wrongProductionCleared(d);
  }
};

const _wrongArticleCleared = (d) =>
  d.wrongArticleManualClear === true ||
  d.humanReviewedWrongArticle === false;

// Retraction of a stale CLEAR breadcrumb (#1020/#1022/#1023). The inverse
// direction of everything else in this table: here the deleted field IS a clear
// breadcrumb, removed because it contradicted an exclusion flag that is still
// live (audit-self-contradictory-clears.js --fix). Without this exception the
// restore resurrects the very breadcrumb the sweep removed and --fix is a
// permanent no-op — the exact shape of the stale-duplicateOf incident above.
// FIELD-SCOPED: the stamp lists exactly which fields the retraction covers, and
// this checks membership. A bare "stamp is non-empty" test would be a standing
// bypass — one retraction of wrongProductionAutoCleared would thereafter
// authorize losing crossOutletVerified to any unrelated bad write. An ordinary
// run that never wrote the stamp still gets full data-loss protection.
const _clearBreadcrumbRetracted = (field) => (d) => {
  if (_isEmptyValue(d.clearBreadcrumbRetracted)) return false;
  const fields = d.clearBreadcrumbRetractedFields;
  return Array.isArray(fields) && fields.includes(field);
};

const CLEAR_BREADCRUMBS = {
  duplicateOf: (d) => !_isEmptyValue(d.duplicateClearReason),
  duplicateReason: (d) => !_isEmptyValue(d.duplicateClearReason),
  wrongProductionAutoCleared: _clearBreadcrumbRetracted('wrongProductionAutoCleared'),
  wrongProductionAutoClearedAt: _clearBreadcrumbRetracted('wrongProductionAutoClearedAt'),
  wrongShowAutoCleared: _clearBreadcrumbRetracted('wrongShowAutoCleared'),
  wrongShowAutoClearedAt: _clearBreadcrumbRetracted('wrongShowAutoClearedAt'),
  crossOutletVerified: _clearBreadcrumbRetracted('crossOutletVerified'),
  wrongProduction: (d) => _wrongProductionCleared(d) || _freshWrongProductionAutoClear(d),
  wrongProductionNote: (d) => _wrongProductionCleared(d) || _freshWrongProductionAutoClear(d),
  wrongProductionReason: _wrongProductionCleared,
  wrongShow: _wrongShowCleared,
  wrongShowReason: _wrongShowCleared,
  wrongShowNote: _wrongShowCleared,
  wrongFullText: _wrongArticleCleared,
  wrongAttribution: _wrongArticleCleared,
  originalScore: (d) => d.originalScoreCleared === true,
  originalScoreSource: (d) => d.originalScoreCleared === true,
  originalScoreNormalized: (d) => d.originalScoreCleared === true,
  // strip-stale-single-model-scores.js --before-opening mode (opening-night-
  // express.yml): removes prior-production score contamination and stamps
  // staleScoredBeforeOpening(+At) so the restore doesn't undo it later in the
  // same job. See PROTECTED_FIELDS comment above for the incident this
  // prevents. FRESHNESS-GATED (codex adversarial review, task #97): the
  // strip's own markRescoreComplete() success path clears both fields the
  // moment a real score lands (rescore-lifecycle.js), but that's a second
  // line of defense, not the only one — mirrors _freshWrongProductionAutoClear
  // below. Without a bound, a stamp that outlives its job (e.g. a scoring
  // failure that never reaches markRescoreComplete) would keep suppressing
  // the restore of ANY future, unrelated score written to committed for this
  // file, forever. 3 days comfortably covers the two same-job push-review-
  // texts calls opening-night-express.yml makes (and any immediate retry)
  // while still expiring long before it could mask a later real bug.
  assignedScore: (d) => _freshStaleScoredBeforeOpening(d) || _freshFullTextWrongAuthor(d),
  llmScore: _freshStaleScoredBeforeOpening,
  llmMetadata: _freshStaleScoredBeforeOpening,
  ensembleData: (d) => _freshStaleScoredBeforeOpening(d) || _freshFullTextWrongAuthor(d),
  // apply-audit-flags.js (task #1237): deletes fullText alongside assignedScore/
  // ensembleData when a byline mismatch is detected — see PROTECTED_FIELDS
  // comment above and _freshFullTextWrongAuthor. fullText has no other
  // CLEAR_BREADCRUMBS entry (unlike assignedScore/ensembleData, which are also
  // cleared by the unrelated stale-before-opening strip), so no OR needed.
  fullText: _freshFullTextWrongAuthor,
  // audit-stuck-rescore-flags.js --fix (task #1259): deletes needsRescore/
  // rescoreReason/lateStarAnchorBand when the flag is permanently stuck (the
  // scorer would reject the file, so it could never clear itself). See
  // PROTECTED_FIELDS comment above and _freshStuckRescoreCleared.
  needsRescore: _freshStuckRescoreCleared,
  rescoreReason: _freshStuckRescoreCleared,
  lateStarAnchorBand: _freshStuckRescoreCleared,
};

/**
 * Returns true when `field` is empty in `localData` BECAUSE it was deliberately
 * cleared (a durable breadcrumb proves it), so a rebase-time restore should NOT
 * resurrect the committed/remote value. Returns false for fields with no
 * registered breadcrumb (default to data-loss protection).
 *
 * @param {string} field
 * @param {object} localData - the local/working-tree review record
 * @param {object} [committedData] - the committed/remote counterpart the
 *   restore would copy FROM, when the caller has it. Lets the url-change
 *   breadcrumb distinguish old-era values (suppress) from same-era values
 *   (restore — that's legitimate data-loss healing).
 * @returns {boolean}
 */
function isIntentionalClear(field, localData, committedData) {
  if (!localData) return false;
  const pred = CLEAR_BREADCRUMBS[field];
  if (typeof pred === 'function' && pred(localData)) return true;
  return _urlChangeCleared(field, localData, committedData);
}

/**
 * url-change-invariant breadcrumb (Notion 399637c5): `_urlChangedClear.cleared`
 * lists fields deliberately deleted because the file's url moved to a different
 * canonical article. Honored generically for ANY field it names — but only
 * while the record still carries the url the clear was made for, so a later
 * URL era's legitimate values aren't suppressed by a stale breadcrumb. When the
 * caller supplies the committed/remote record, a same-era committed value is
 * never suppressed: it was written after the URL change, so restoring it heals
 * real data loss — without this, a post-refetch fullText lost to a later
 * rebase would stay lost because the old breadcrumb still names 'fullText'.
 * "Same era" requires the committed record to carry a matching breadcrumb
 * (same `to`, same url) — not merely a matching url. Frankenstein committed
 * states with the NEW url but old-era field values exist in history (produced
 * by the pre-invariant restores this machinery remediates, JCS 2026-07-08..10);
 * keying on url alone would restore that contamination on every rebase.
 */
function _urlChangeCleared(field, localData, committedData) {
  const b = localData._urlChangedClear;
  if (!b || !Array.isArray(b.cleared) || !b.cleared.includes(field)) return false;
  try {
    const cb = committedData && committedData._urlChangedClear;
    if (cb && cb.to && committedData.url && localData.url
        && _normalizeUrlForCollision(committedData.url) === _normalizeUrlForCollision(localData.url)
        && _normalizeUrlForCollision(String(cb.to)) === _normalizeUrlForCollision(committedData.url)) {
      return false;
    }
  } catch { /* fall through to the era gate */ }
  if (!b.to || !localData.url) return true;
  try {
    return _normalizeUrlForCollision(localData.url) === _normalizeUrlForCollision(b.to);
  } catch {
    return true;
  }
}

/**
 * Task #653/#816 — protect a file findExistingReviewFile() refused to hand
 * back as a merge target (it carries wrongProduction/wrongShow) from two
 * distinct ways a "fresh discovery/extraction" write can clobber it:
 *
 * 1. url: safeWriteReview() preserves PROTECTED_FIELDS, but a canonical URL
 *    change first runs applyUrlChangeInvariant, which deliberately clears
 *    wrongProduction/wrongProductionNote/contentTier AND publishDate as
 *    "old-URL-derived" — and with publishDate gone, flag-wrong-production-by-date
 *    can never re-derive the Date guard, so the review re-enters reviews.json
 *    permanently. The re-discovered/re-scraped URL is rarely the article's
 *    actual URL in this scenario (aggregator link, SERP guess, etc.); the
 *    file's own URL already won this fight once.
 * 2. Any other PROTECTED field (contentTier, fullText, assignedScore, …):
 *    several callers unconditionally stamp a fresh value on every write
 *    (fresh contentTier, freshly-scraped fullText, …). safeWriteReview only
 *    restores a PROTECTED field when the incoming write OMITS it — an
 *    explicit non-empty overwrite passes straight through unprotected — so a
 *    flagged file's tier/text/score would be silently replaced by content
 *    the extractor pulled for the WRONG production. Deleting every
 *    PROTECTED_FIELDS key the caller set lets safeWriteReview's
 *    merge-from-existing pass restore the on-disk values instead. A
 *    deliberate correction of a flagged file's content belongs to a
 *    dedicated flag-clearing script (force=true / manual clear), not an
 *    ordinary re-extraction blind to the flag.
 *
 * Mirrors the inline guard in extract-dtli-reviews.js saveReview() (Notion
 * 383637c5-416f-8107), generalized to the PROTECTED_FIELDS clobber found in
 * ship-check on the sibling scripts.
 *
 * @param {string} filePath - Absolute path the caller is about to write
 * @param {object} review - The review payload about to be written
 * @returns {object} `review`, or a shallow copy adjusted to defer to the on-disk flagged file
 */
function preserveFlaggedFields(filePath, review) {
  if (!review || !fs.existsSync(filePath)) return review;
  try {
    const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (!onDisk || !(onDisk.wrongProduction || onDisk.wrongShow || onDisk.duplicateOf)) return review;
    // An incoming write that is itself an intentional clear (carries a
    // CLEAR_BREADCRUMBS breadcrumb — e.g. wrongProductionManualClear) must
    // reach safeWriteReview's isIntentionalClear/incomingSnapshot machinery
    // untouched. Every breadcrumb field lives in PROTECTED_FIELDS, so
    // stripping it here (as this function does below) would silently
    // resurrect a flag the caller deliberately cleared.
    for (const field of Object.keys(CLEAR_BREADCRUMBS)) {
      if (isIntentionalClear(field, review)) return review;
    }
    const adjusted = { ...review };
    delete adjusted.url;
    delete adjusted.publishDate;
    for (const field of PROTECTED_FIELDS) {
      if (field in adjusted) delete adjusted[field];
    }
    return adjusted;
  } catch { /* corrupt file — fall through */ }
  return review;
}

/**
 * Safely write a review JSON file, preserving any existing scored/collected data.
 *
 * @param {string} filePath - Absolute path to the review JSON file
 * @param {object} newData - The data to write
 * @param {object} [options]
 * @param {boolean} [options.force=false] - Skip protection (for intentional overwrites like rescoring)
 * @param {boolean} [options.merge=true] - If true, merge with existing; if false, replace (still protected)
 * @returns {{ wrote: boolean, preserved: string[] }} Which protected fields were preserved
 */
function safeWriteReview(filePath, newData, options = {}) {
  const { force = false, merge = true } = options;
  const preserved = [];
  let lockedSkipped = false;

  // Google-redirect unwrap at the write choke point. Enrichment writers that
  // fill `url` from SERP results can store the google.com/url?q=... WRAPPER
  // instead of the article URL; rebuild then drops the review as a blocked
  // domain (skippedBlockedUrl) while a byline-less SERP sibling takes its slot
  // (JCS artsdesk/Halliburton, 2026-07-09, Notion 39a637c5-416f-813a).
  // fetchPage() unwraps at FETCH time, so this catches only writes — the lazy
  // require fires exclusively on wrapped URLs (rare) to keep module load light.
  if (newData && typeof newData.url === 'string' && /\/\/(www\.)?google\.[^/]+\/url\?/.test(newData.url)) {
    const unwrapped = require('./scraper').unwrapRedirectUrl(newData.url);
    if (unwrapped !== newData.url) {
      newData = { ...newData, url: unwrapped, urlUnwrappedFrom: newData.url };
      console.log(`[review-write-guard] ${path.basename(filePath)}: unwrapped google-redirect url → ${unwrapped}`);
    }
  }

  // Awaiting-URL-correction-refetch guard — the ROOT-CAUSE fix for the #483
  // drain→rebuild→re-flag loop that kept `audit-stale-flag-after-url-correction
  // --gate` red on main for 24h+ across two sessions.
  //
  // A record whose URL was corrected but whose body has not been refetched still
  // carries the OLD article's publishDate. Every date-derived guard treats that
  // stale date as evidence and stamps wrongProduction — recreating exactly what
  // the gate clears. Drain and re-flag then chase each other forever.
  //
  // Fixing this per-producer does not work and has now failed twice:
  //   2026-08-13  fixed scripts/flag-wrong-production-by-date.js  → red again same evening
  //   2026-08-13  fixed rebuild-all-reviews.js's inline copy      → this guard exists so there is no third round
  // At least 5 scripts set these flags and none consulted the breadcrumb; a 6th
  // added next month would reopen it. safeWriteReview is the ENFORCED single
  // write path (test.yml:2967 "Check scripts route review-texts writes through
  // safeWriteReview"), so an invariant here binds every producer, present and
  // future, without any of them having to remember.
  //
  // Explicit operator overrides still pass — a human asserting wrongProduction
  // on a mid-correction record (e.g. the Equus 2019-Trafalgar-URL files) is a
  // judgement about the CONTENT, not a date-derived inference.
  // Lazy require: stale-flag-after-url-correction → wrongprod-replacement-preserve
  // → PROTECTED_FIELDS in THIS module, so a top-level import is a require cycle
  // that leaves PROTECTED_FIELDS undefined and breaks every review write. Same
  // reason the google-redirect unwrap above requires ./scraper lazily.
  const { isAwaitingUrlCorrectionRefetch } = require('./stale-flag-after-url-correction');
  if (newData && isAwaitingUrlCorrectionRefetch(newData)) {
    const operatorAsserted = newData.wrongProductionOverride === true ||
      newData.wrongShowManualClear === true ||
      newData.humanReviewedWrongProduction === true;
    if (!operatorAsserted) {
      for (const flag of ['wrongProduction', 'wrongShow']) {
        if (newData[flag] === true) {
          console.warn(`[awaiting-refetch-guard] ${path.basename(filePath)}: dropped ${flag}=true — record is mid-URL-correction, publishDate still describes the old article (not evidence). Re-evaluate after the refetch lands.`);
          newData = { ...newData, [flag]: false };
          delete newData[`${flag}Note`];
        }
      }
    }
  }

  // Temporal byline guard — refuse to write attributions to retired/deceased
  // critics for articles dated past their last-active date.
  // (Soft warnings — like Brantley freelance pieces — pass through with a log.)
  if (newData && newData.criticName && (newData.publishDate || newData.parsedDate)) {
    const tcheck = validateTemporalAttribution(newData.criticName, newData.publishDate || newData.parsedDate);
    if (tcheck.warning) {
      console.warn(`[temporal-byline-guard] ${path.basename(filePath)}: ${tcheck.warning}`);
    }
    if (tcheck.hardBlock) {
      console.error(`[temporal-byline-guard] BLOCKED write to ${path.basename(filePath)}: ${tcheck.reason}`);
      // Downgrade attribution to Unknown so the review still lands but doesn't
      // pollute the dead/retired critic's page. Log so a human can fix later.
      newData = { ...newData, criticName: 'Unknown', _temporalGuardBlocked: tcheck.reason };
    }
  }

  // Date-plausibility quarantine (card #832, Notion 3b0637c5): a review file
  // whose publishDate lands implausibly before the show's earliest date is
  // almost always a different production of the same title leaking onto this
  // entry — 5 incidents of this class (sylvia #499, crocodile #730/#832,
  // oscar #738, cyrano #832), each only caught post-commit by validate-data.js
  // CHECK 0 after it had already turned main red. Gate the write here so the
  // bad publishDate never lands in the show dir at all.
  //
  // Fires when publishDate is arriving for the FIRST time: either a
  // brand-new file, or an existing dateless file (e.g. a stub written by
  // saveAggregatorStub()/registration passes with no publishDate yet) whose
  // incoming write finally supplies one. That covers the ship-check-flagged
  // gap where discovery writes a placeholder first and a later fetch pass
  // fills in the real (possibly implausible) date — a plain isNewFile check
  // would have let that second write sail through untouched. Does NOT
  // re-fire on every subsequent edit to an already-dated file (that would
  // re-litigate settled/flagged files and disrupt the 100+ other
  // safeWriteReview callers that merge updates), and does not fire once the
  // file carries any protected/scored field (a human-vetted or scored review
  // getting a corrected date is a deliberate fixup, not new ingest).
  {
    const parentDirName = path.basename(path.dirname(filePath));
    const grandparentDirName = path.basename(path.dirname(path.dirname(filePath)));
    let priorPublishDate = null;
    let hadProtectedContent = false;
    const fileExists = fs.existsSync(filePath);
    if (fileExists) {
      try {
        const onDiskForDateCheck = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        priorPublishDate = onDiskForDateCheck.publishDate || null;
        hadProtectedContent = getEffectiveProtectedFields(onDiskForDateCheck)
          .some(k => onDiskForDateCheck[k] !== undefined && onDiskForDateCheck[k] !== null && onDiskForDateCheck[k] !== '');
      } catch { /* unreadable existing file — treat as dateless, still gate below */ }
    }
    const isDateFirstArriving = (!fileExists || !priorPublishDate) && !hadProtectedContent;
    if (isDateFirstArriving && grandparentDirName !== '_pending' && parentDirName
      && !parentDirName.startsWith('_') && !parentDirName.startsWith('.')) {
      const show = _getShowById(parentDirName);
      if (show) {
        const { evaluateDatePlausibility } = require('./date-plausibility');
        const verdict = evaluateDatePlausibility({ review: newData, show });
        if (verdict.implausible) {
          const pendingDir = path.join(path.dirname(path.dirname(filePath)), '_pending', parentDirName);
          fs.mkdirSync(pendingDir, { recursive: true });
          const pendingPath = path.join(pendingDir, path.basename(filePath));
          const quarantined = {
            ...newData,
            pendingReason: 'date_implausible',
            _dateImplausibleDetail: `publishDate ${newData.publishDate} is ${verdict.daysBefore}d before earliest show date ${verdict.earliestDate}`,
          };
          fs.writeFileSync(pendingPath, JSON.stringify(quarantined, null, 2) + '\n');
          console.warn(`[review-write-guard] date-implausible: ${parentDirName}/${path.basename(filePath)} → quarantined to _pending/${parentDirName}/${path.basename(filePath)} (${verdict.daysBefore}d before earliest date, not within priorRuns)`);
          return { wrote: false, skipped: 'date_implausible', quarantinedPath: pendingPath, daysBefore: verdict.daysBefore };
        }

        // Cross-market class-A quarantine (card #1085). The mirror of the check
        // above: date-plausibility only catches a review dated implausibly
        // BEFORE this show's earliest date. It cannot see the tryout/transfer
        // shape, where the leaking review is dated LATER than the folder show's
        // opening — on a same-title sibling's. That is exactly what re-reddened
        // main: gather for 'the-outsiders-world-premiere-regional-2023' (La
        // Jolla, opened 2023-03-07) picked up EW + TheWrap reviews of the
        // BROADWAY production dated 2024-04-11 — 0 days from the-outsiders-2024's
        // opening, 401 from the tryout's. Deleted by hand on 2026-08-06; the
        // Weekly review refresh cron re-created them 17h later, because the
        // preventer added that day lives inline in gather-reviews.js's
        // saveReview and extract-dtli-reviews.js does not go through it.
        //
        // Putting it HERE, at the shared write chokepoint (78 caller scripts),
        // is what makes the class unrepeatable rather than per-writer whack-a-mole.
        // Uses classifyClassAContamination — the SAME predicate the zero-tolerance
        // CI gate flags on — so detector and preventer can never disagree.
        // Quarantines rather than drops: _pending/ is recoverable if a human
        // disagrees, and `_auditAllowCrossMarket` (the audit's own manual
        // allowlist) opts a file out here too.
        if (newData && newData.publishDate && !newData._auditAllowCrossMarket) {
          const sibOpenings = _getSiblingOpenings(parentDirName);
          if (sibOpenings.length) {
            const { classifyClassAContamination } = require('./cross-market-contamination');
            const xv = classifyClassAContamination(
              new Date(newData.publishDate),
              show.openingDate ? new Date(show.openingDate) : null,
              sibOpenings
            );
            if (xv.isClassA) {
              const pendingDir = path.join(path.dirname(path.dirname(filePath)), '_pending', parentDirName);
              fs.mkdirSync(pendingDir, { recursive: true });
              const pendingPath = path.join(pendingDir, path.basename(filePath));
              const detail = `publishDate ${newData.publishDate} is ${Math.round(xv.sibDiff)}d from a same-title sibling production's opening but ${Math.round(xv.thisDiff)}d from this show's — it belongs to the sibling`;
              fs.writeFileSync(pendingPath, JSON.stringify({
                ...newData,
                pendingReason: 'cross_market_contamination',
                _crossMarketDetail: detail,
              }, null, 2) + '\n');
              console.warn(`[review-write-guard] cross-market (class A): ${parentDirName}/${path.basename(filePath)} → quarantined to _pending/${parentDirName}/${path.basename(filePath)} (${detail})`);
              return {
                wrote: false,
                skipped: 'cross_market_contamination',
                quarantinedPath: pendingPath,
                sibDiff: xv.sibDiff,
                thisDiff: xv.thisDiff,
              };
            }
          }
        }
      }
    }
  }

  // Bug #25: When force=true, log protected fields that would be lost so CI logs show it.
  if (force && fs.existsSync(filePath)) {
    let existingForAudit;
    try { existingForAudit = JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch {}
    if (existingForAudit) {
      const effectiveFields = getEffectiveProtectedFields(existingForAudit);
      const overriding = effectiveFields.filter(k => {
        const existingVal = existingForAudit[k];
        const newVal = newData[k];
        const existingIsReal = existingVal !== undefined && existingVal !== null
          && !(typeof existingVal === 'string' && existingVal.length === 0)
          && !(Array.isArray(existingVal) && existingVal.length === 0);
        const incomingIsEmpty = newVal === undefined || newVal === null
          || (typeof newVal === 'string' && newVal.length === 0)
          || (Array.isArray(newVal) && newVal.length === 0);
        return existingIsReal && incomingIsEmpty;
      });
      if (overriding.length > 0) {
        console.warn(`[review-write-guard] FORCE write to ${path.basename(filePath)} — overriding: ${overriding.join(', ')}`);
      }
    }
  }

  if (!force && fs.existsSync(filePath)) {
    let existing;
    try {
      existing = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
      existing = null;
    }

    if (existing) {
      // Joe Turner postmortem P0 #2 (2026-04-26): _locked must be honored
      // at the writer, not in each enrichment script. existing was just read
      // fresh from disk above, so a parallel writer's _locked flag is visible
      // to us. force=true still bypasses (intentional override path —
      // strip-stale-single-model-scores --force-strip-locked, etc.).
      const lockedOverride = existing._locked === true && !force;

      // Intentional-clear decisions are FROZEN against a snapshot of the
      // caller's original payload BEFORE the preserve loop mutates newData.
      // Without the snapshot, restoring a breadcrumb field (e.g.
      // wrongProductionOverride) from `existing` into `newData` mid-loop
      // makes every later breadcrumb-keyed field look intentionally cleared
      // even though the incoming write carried no breadcrumb at all
      // (adversarial review, 2026-08-02).
      //
      // Additionally, a clear is only honored when the incoming write is the
      // one PERFORMING it: if `existing` ALREADY satisfies the same clear
      // breadcrumb, the flag on disk was re-set deliberately over a prior
      // clear (or the caller is replaying a stale read) — preserving wins.
      // Re-clearing such a file goes through the canonical clear scripts
      // (direct write) or force=true.
      const incomingSnapshot = { ...newData };
      const clearHonored = (field) =>
        isIntentionalClear(field, incomingSnapshot, existing)
        && !isIntentionalClear(field, existing, existing);

      const effectiveFields = getEffectiveProtectedFields(existing);
      for (const field of effectiveFields) {
        const existingVal = existing[field];
        const newVal = newData[field];
        // Preserve existing non-empty when incoming is any form of empty.
        // Previously only undefined/null were treated as empty — the poller
        // writes stubs with fullText='' (empty string) which passed the
        // check and CLOBBERED scored reviews. See 2026-04-17 Proof opening
        // P0 incident (card 345637c5-416f-81df).
        const existingIsReal = existingVal !== undefined && existingVal !== null
          && !(typeof existingVal === 'string' && existingVal.length === 0)
          && !(Array.isArray(existingVal) && existingVal.length === 0);
        const incomingIsEmpty = newVal === undefined || newVal === null
          || (typeof newVal === 'string' && newVal.length === 0)
          || (Array.isArray(newVal) && newVal.length === 0);
        // Locked override: preserve every PROTECTED field on a locked file
        // even when incoming has a real value. The lock means the human or
        // ingest pipeline declared the file canonical; nothing downstream
        // should mutate scored/collected fields without force=true.
        //
        // Intentional-clear exception (2026-08-02): a write that DELETES a
        // flag while carrying its registered clear breadcrumb (e.g. deletes
        // wrongProduction with wrongProductionOverride/ManualClear set) is a
        // deliberate recovery, not data loss — the same isIntentionalClear()
        // contract the rebase-time restore already honors. Without this, a
        // clearWrongProductionFlags() + safeWriteReview() pipeline silently
        // resurrects the flag it just cleared (observed live: Traitors/Space
        // Dogs FP recovery, session 2026-08-02). A lock still wins: clearing
        // flags on a _locked file requires force=true.
        if (existingIsReal && (incomingIsEmpty || lockedOverride)) {
          const intentionalClear = !lockedOverride && incomingIsEmpty
            && clearHonored(field);
          if (intentionalClear) {
            console.log(`[review-write-guard] ${path.basename(filePath)}: honoring intentional clear of "${field}" (breadcrumb present on incoming write)`);
          } else if (newData[field] !== existingVal) {
            newData[field] = existingVal;
            preserved.push(field);
            if (lockedOverride && !incomingIsEmpty) lockedSkipped = true;
          }
        }
      }

      // If merge mode, also keep any existing fields not in newData.
      // Intentional-clear exception (2026-08-02): same contract as the
      // preserve loop above — a field deleted WITH its registered clear
      // breadcrumb must not be merged back from disk, or the merge pass
      // silently undoes the clear the preserve loop just honored. Locked
      // files still merge everything back (lock requires force to clear).
      const mergeLockedOverride = existing._locked === true && !force;
      if (merge) {
        for (const [key, val] of Object.entries(existing)) {
          if (newData[key] === undefined) {
            if (!mergeLockedOverride && clearHonored(key)) continue;
            newData[key] = val;
          }
        }
      }

      // Write-topology invariant (Notion 399637c5): a write that moves this
      // file's url to a DIFFERENT canonical article must not carry old-URL-
      // derived state (flags, excerpts, stars, scores, text) — that state was
      // computed from an article this file no longer points at. Runs AFTER the
      // preservation+merge passes so it catches exactly what they carried over
      // (fields the incoming write refreshed differ from `existing` and
      // survive). Manual URL decisions win first: a urlVerified /
      // urlManualOverride url — and any url on a _locked file — is only
      // replaceable via force (mirrors mergeReviews' blockUrlChange).
      {
        const { urlCanonicallyChanged, applyUrlChangeInvariant } = require('./url-change-invariant');
        // The protection block must NOT key on urlCanonicallyChanged: that
        // predicate deliberately returns false for garbage incoming urls
        // ('undefined', non-http), and gating the block on it would let a
        // garbage url silently overwrite a verified/locked url (ship-check
        // 2026-07-11 regression catch). A garbage incoming url never replaces
        // a real existing url on ANY file — compared as RAW strings, because a
        // protocol-less variant of the same article ('nytimes.com/x' vs
        // 'https://nytimes.com/x') normalizes EQUAL yet must still be
        // rejected, not written.
        const existingUrlReal = typeof existing.url === 'string' && existing.url
          && !existing.url.includes('undefined');
        const incomingUrlGarbage = typeof newData.url === 'string' && newData.url
          && (newData.url.includes('undefined') || !/^https?:\/\//i.test(newData.url));
        const normalizedUrlDiffers = existingUrlReal && typeof newData.url === 'string' && newData.url
          && _normalizeUrlForCollision(newData.url) !== _normalizeUrlForCollision(existing.url);
        if (existingUrlReal && incomingUrlGarbage && newData.url !== existing.url) {
          console.warn(`[review-write-guard] rejecting garbage url ${JSON.stringify(newData.url)} on ${path.basename(filePath)}: keeping ${existing.url}`);
          newData.url = existing.url;
        } else if (normalizedUrlDiffers && (lockedOverride || existing.urlVerified === true || existing.urlManualOverride === true)) {
          console.warn(`[review-write-guard] blocked url change on ${path.basename(filePath)} (${lockedOverride ? '_locked' : 'urlVerified/urlManualOverride'}): keeping ${existing.url}`);
          newData.url = existing.url;
        } else if (urlCanonicallyChanged(existing.url, newData.url)) {
          const inv = applyUrlChangeInvariant(existing, newData, { fileLabel: path.basename(filePath) });
          for (const f of inv.cleared) {
            const i = preserved.indexOf(f);
            if (i !== -1) preserved.splice(i, 1);
          }
          // The llm-scores sidecar is keyed by filename; when the URL change
          // cleared the inline llmScore, the sidecar's copy belongs to the old
          // article and must go too, or sidecar consumers re-read stale scores.
          if (inv.cleared.includes('llmScore')) {
            const { removeLlmScoreSidecar } = require('./url-change-invariant');
            removeLlmScoreSidecar(filePath);
          }
        }
      }
    }
  }

  // Aggregator score contamination guard (2026-05-25): when scoreSource is in
  // AGGREGATOR_SCORE_SOURCES, the aggregator stars belong in aggregatorStars
  // only — never in originalScore. The merge-mode above can re-introduce a
  // stale originalScore if the previous on-disk file had one. validate-data.js
  // validateAggregatorScoreContamination fails CI on this combination; the
  // scrapers (gather-reviews.js, sweep-we-aggregators.js) correctly write
  // originalScore=null but the merge restores the disk value. Strip here.
  {
    const { AGGREGATOR_SCORE_SOURCES } = require('./review-normalization');
    if (newData.scoreSource && AGGREGATOR_SCORE_SOURCES.has(newData.scoreSource) && newData.originalScore != null) {
      console.warn(`[review-write-guard] stripping originalScore (${JSON.stringify(newData.originalScore)}) from ${path.basename(filePath)}: scoreSource=${newData.scoreSource} is aggregator; canonical value lives in aggregatorStars`);
      newData.originalScore = null;
      newData.originalScoreSource = null;
      newData.originalScoreType = null;
      newData.originalScoreNormalized = null;
    }
  }

  // Pattern Card #7: schema validation — originalScore must be a string, not a bare integer.
  // A bare number like 5 is ambiguous (5/100 or 5 stars?). The canonical form is always a
  // string ("5/5", "★★★★★", "5 stars"). Log a warning but don't block the write.
  if (newData.originalScore != null && typeof newData.originalScore === 'number') {
    const caller = new Error().stack.split('\n')[2]?.trim() || 'unknown';
    console.warn(`[review-write-guard] originalScore is a number (${newData.originalScore}) in ${path.basename(filePath)} — should be a string. Caller: ${caller}`);
  }

  // Schmigadoon 2026 bug #6 guard: assignedScore must be null or a finite number.
  // Schema drift shipped "2/4 stars" (string) to reviews.json because some ingest
  // path wrote the raw rating string into the numeric slot. Coerce known rating
  // patterns via the shared parseRating() helper; null + log anything unparseable.
  const coercion = coerceAssignedScore(newData, filePath);
  if (coercion.changed) {
    console.warn(`[review-write-guard] assignedScore coerced in ${path.basename(filePath)}: ${JSON.stringify(coercion.from)} → ${coercion.to} (${coercion.reason})`);
  }

  // Pattern Card #8: Placeholder URL detection — flag fabricated/stub URLs that
  // contain sequential-digit placeholder patterns (e.g. Joe Turner WSJ fake ID
  // SB123944876543210987 found in 2026-04-26 catalog audit, 8 similar files).
  // FLAG-ONLY — does not block the write because the false-positive rate on real
  // URLs is not yet characterised. Downstream auditors can filter urlPlaceholderSuspect=true.
  if (newData.url && hasPlaceholderUrlPattern(newData.url)) {
    newData.urlPlaceholderSuspect = true;
    console.warn(`[review-write-guard] placeholder URL detected in ${path.basename(filePath)}: ${newData.url}`);
  }

  // Self-heal self-referential `duplicateOf` — a file can never be a duplicate of
  // itself. This nonsensical state (145 corpus-wide, 2026-06-28) is reported as a
  // "duplicate" gap by the completeness census and can confuse dedup tiebreaks.
  // Always clear; duplicateClearReason is the push-restore exception breadcrumb.
  if (newData.duplicateOf && newData.duplicateOf === path.basename(filePath)) {
    console.warn(`[review-write-guard] clearing self-referential duplicateOf in ${path.basename(filePath)}`);
    newData.duplicateClearReason = `auto-cleared at write: self-referential duplicateOf (pointed at own filename)`;
    newData.duplicateOf = null;
    newData.duplicateReason = null;
  }

  // Same self-heal for `duplicateTextOf` (the content-fingerprint dedup pointer):
  // self-reference (born when safeRenameReview renames a flagged *--unknown.json
  // ONTO its pointer target once the byline is identified — 116 corpus-wide,
  // 2026-07-09 JCS) and dangling target. URL mismatch is deliberately NOT
  // checked here — identical text at different URLs is exactly what
  // duplicateTextOf encodes (syndication). No duplicateTextOfCleared marker:
  // the fingerprint pass must stay free to re-flag with a correct pointer.
  if (newData.duplicateTextOf && newData.duplicateTextOf === path.basename(filePath)) {
    console.warn(`[review-write-guard] clearing self-referential duplicateTextOf in ${path.basename(filePath)}`);
    newData.duplicateClearReason = `auto-cleared at write: self-referential duplicateTextOf (pointed at own filename)`;
    // Delete rather than null — validate-data flags null as "should be string".
    delete newData.duplicateTextOf;
  }
  if (newData.duplicateTextOf && typeof newData.duplicateTextOf === 'string' && newData.duplicateTextOf.endsWith('.json')) {
    try {
      if (!fs.existsSync(path.join(path.dirname(filePath), newData.duplicateTextOf))) {
        console.warn(`[review-write-guard] clearing dangling duplicateTextOf in ${path.basename(filePath)}: sibling ${newData.duplicateTextOf} no longer exists`);
        newData.duplicateClearReason = `auto-cleared at write: duplicateTextOf sibling ${newData.duplicateTextOf} no longer exists`;
        delete newData.duplicateTextOf;
      }
    } catch { /* silent — best-effort self-heal */ }
  }

  // Self-heal stale `duplicateOf` whose URL no longer matches the referenced file.
  // Triggered by Can I Be Frank case (2026-05-24): Sommers's URL was briefly
  // corrected to Bernardo's URL, fired url-collision-detected-at-write, then the
  // URL was restored to Sommers's actual review URL — but the duplicateOf flag
  // persisted, silently excluding a legitimate T2 review from the rebuild.
  // Rule: if duplicateOf points at a sibling whose URL no longer matches ours,
  // the collision basis is gone, so clear the flag.
  if (newData.duplicateOf && newData.url) {
    try {
      const siblingPath = path.join(path.dirname(filePath), newData.duplicateOf);
      if (!fs.existsSync(siblingPath)) {
        // Sibling was deleted (typically *--unknown.json files swept as junk by
        // collect-review-texts cleanup). The duplicateOf reference is now
        // dangling and excludes this review from rebuild for no reason.
        // The CI audit-duplicate-of-url-mismatch.js gate flags this; clear at
        // write site so it self-heals on the next gather/rebuild rather than
        // accumulating until the next manual --fix run.
        console.warn(`[review-write-guard] clearing dangling duplicateOf in ${path.basename(filePath)}: sibling ${newData.duplicateOf} no longer exists`);
        newData.duplicateClearReason = `auto-cleared at write: sibling ${newData.duplicateOf} no longer exists`;
        newData.duplicateOf = null;
        newData.duplicateReason = null;
      } else {
        const siblingData = JSON.parse(fs.readFileSync(siblingPath, 'utf-8'));
        if (siblingData.url) {
          const normHere = _normalizeUrlForCollision(newData.url);
          const normSibling = _normalizeUrlForCollision(siblingData.url);
          if (normHere !== normSibling) {
            console.warn(`[review-write-guard] clearing stale duplicateOf in ${path.basename(filePath)}: URL no longer matches ${newData.duplicateOf} (${newData.url} vs ${siblingData.url})`);
            newData.duplicateClearReason = `auto-cleared at write: URL ${newData.url} no longer matches sibling ${newData.duplicateOf} URL ${siblingData.url}`;
            newData.duplicateOf = null;
            newData.duplicateReason = null;
          }
        }
      }
    } catch { /* silent — best-effort self-heal */ }
  }

  // Pattern Card #4: URL collision detection — warn before writing a file whose URL
  // already exists in another file in the same show directory.
  // Files mid-correction (urlCorrectedFrom set) get the CONSERVATIVE decision
  // path (shouldMarkPostCorrectionDuplicate) instead of being skipped entirely:
  // the URL-upgrade path is exactly where same-URL duplicates are born
  // (maybeUpgradeUrl adopting an aggregator-cited URL a named sibling already
  // owns), and the old blanket skip meant those could never be tombstoned —
  // plus urlCorrectedFrom persists forever, permanently exempting the file
  // (the-enormous-crocodile london-theatre--unknown weekly oscillation,
  // 2026-08-01).
  if (!force && newData.url) {
    const collider = checkUrlCollision(filePath, newData);
    if (collider) {
      let colliderData = null;
      try {
        colliderData = JSON.parse(fs.readFileSync(path.join(path.dirname(filePath), collider), 'utf-8'));
      } catch { /* unreadable collider — fall back to marking dup (historical behavior) */ }
      // Sibling loader for the N-hop cycle walk, seeded with the collider read
      // above so it costs no extra I/O in the (overwhelmingly common) 2-node
      // case; only walking past the collider touches disk again.
      const siblingDir = path.dirname(filePath);
      const siblingCache = { [collider]: colliderData };
      const loadSibling = (name) => {
        if (Object.prototype.hasOwnProperty.call(siblingCache, name)) return siblingCache[name];
        try {
          siblingCache[name] = JSON.parse(fs.readFileSync(path.join(siblingDir, name), 'utf-8'));
        } catch {
          siblingCache[name] = null;
        }
        return siblingCache[name];
      };
      if (wouldFormDuplicateCycle(path.basename(filePath), collider, loadSibling)) {
        // The collider's duplicateOf chain already loops back to us (directly,
        // the A↔B 2-cycle, or via one or more intermediate siblings) — marking
        // us dup of it would close the loop and exclude every member from the
        // rebuild (242 corpus-wide, 2026-07-11; N-node case: Notion #941
        // washpost 3-cycle). Decline to mark; we are the canonical the collider
        // (transitively) defers to. If we were previously (wrongly) marked dup
        // of this same collider, clear it now with a breadcrumb so the
        // push-restore exception (isIntentionalClear) doesn't resurrect the cycle.
        console.warn(`[review-write-guard] URL collision: ${path.basename(filePath)} shares URL with ${collider}, but ${collider}'s duplicateOf chain already loops back to us — keeping primary to avoid a duplicateOf cycle`);
        if (newData.duplicateOf === collider) {
          newData.duplicateClearReason = `auto-cleared at write: refusing duplicateOf cycle with ${collider} (it already points back at us)`;
          newData.duplicateOf = null;
          newData.duplicateReason = null;
        }
      } else if (newData.urlCorrectedFrom
          ? shouldMarkPostCorrectionDuplicate(newData, colliderData)
          : shouldMarkUrlCollisionDuplicate(newData, colliderData)) {
        console.warn(`[review-write-guard] URL collision: ${path.basename(filePath)} shares URL with ${collider} — marking as duplicate`);
        newData.duplicateOf = collider;
        newData.duplicateReason = 'url-collision-detected-at-write';
        // Clear any stale clear-breadcrumb from a prior heal — this file is now a
        // live duplicate again, so a leftover duplicateClearReason would lie about
        // its state (and the push-review-texts restore exception keys on that
        // breadcrumb). Keep the marker consistent with the live flag. 2026-06-01.
        newData.duplicateClearReason = null;
      } else if (newData._duplicateOfCleared) {
        console.warn(`[review-write-guard] URL collision: ${path.basename(filePath)} shares URL with ${collider} but carries a _duplicateOfCleared breadcrumb — honoring the prior clear, not re-marking`);
      } else {
        // Normal path: newData carries the real review body and the collider is
        // a thin/empty same-URL stub. Marking newData duplicate here BURIES the
        // real review under the stub and re-forms a byline-explosion cluster on
        // every write (much-ado Sarah Crompton → alun-hood, 2026-07-05).
        // Post-correction path: newData has a substantive body (possibly a
        // legitimate multi-critic review sharing the URL) or the collider is
        // unreadable — too uncertain to tombstone. Keep primary either way.
        console.warn(`[review-write-guard] URL collision: ${path.basename(filePath)} shares URL with ${collider} — keeping primary (${newData.urlCorrectedFrom ? 'post-URL-correction, not provably duplicate' : 'has the substantive body'})`);
      }
    }
  }

  // showId backstop (2026-07-18): validate-review-texts --gate hard-fails any
  // corpus file missing showId, and writers that build payloads from scratch
  // (show-not-mentioned-recovery URL updates shipped allegra-west-end-2026/
  // whatsonstage--aliya-al.json without one) can turn the whole Test Suite red
  // with a single file. The corpus layout guarantees the immediate parent
  // directory name IS the show id — including under _pending/, whose layout
  // nests show-id dirs (_pending/{show-id}/file.json) — so derive it at the
  // write choke point. The underscore/dot skip exists for dirs whose own name
  // can never be a show id: test-guard dirs, tmp dirs, hidden dirs.
  {
    const dirName = path.basename(path.dirname(filePath));
    if (dirName && !dirName.startsWith('_') && !dirName.startsWith('.')) {
      if (!newData.showId) {
        newData.showId = dirName;
      } else if (newData.showId !== dirName) {
        // Don't auto-correct: a mismatch means the file is misfiled or carries
        // a stale id after a move — both need eyes, not silent rewriting.
        // rebuild groups by data.showId, so this file is being counted under a
        // show it doesn't live in.
        console.warn(`[review-write-guard] showId mismatch in ${path.basename(filePath)}: field says "${newData.showId}" but file lives in "${dirName}"`);
      }
    }
  }

  fs.writeFileSync(filePath, JSON.stringify(newData, null, 2) + '\n');
  return { wrote: true, preserved, lockedSkipped };
}

/**
 * Check if writing newData would destroy scored data in an existing file.
 * Returns list of fields that would be lost. Empty array = safe to write.
 *
 * @param {string} filePath - Path to existing review file
 * @param {object} newData - Proposed new data
 * @returns {string[]} Fields that would be lost
 */
function checkForDataLoss(filePath, newData) {
  if (!fs.existsSync(filePath)) return [];
  let existing;
  try {
    existing = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return [];
  }

  const effectiveFields = getEffectiveProtectedFields(existing);
  const losses = [];
  for (const field of effectiveFields) {
    if (existing[field] !== undefined && existing[field] !== null && (newData[field] === undefined || newData[field] === null)) {
      losses.push(field);
    }
  }
  return losses;
}

/**
 * Returns the effective set of protected fields for a given existing file's data.
 * Unions the global PROTECTED_FIELDS with any per-file protectedFields array.
 * 'protectedFields' itself is always included so it can't be cleared unless force=true.
 *
 * @param {object|null} existingData - Parsed JSON from the existing file (or null)
 * @returns {string[]}
 */
function getEffectiveProtectedFields(existingData) {
  const perFile = (existingData && Array.isArray(existingData.protectedFields))
    ? existingData.protectedFields
    : [];
  const all = new Set([...PROTECTED_FIELDS, ...perFile, 'protectedFields']);
  return Array.from(all);
}

/**
 * Check if the URL in newData is already used by a different review file in
 * the same show directory. Returns the conflicting filename, or null if no collision.
 *
 * Pattern Card #6: URL collisions cause duplicate content when two passes of
 * gather-reviews assign the same URL to different filenames for the same show.
 * Call this before safeWriteReview when creating new files to detect the issue
 * early rather than letting it propagate to reviews.json.
 *
 * @param {string} filePath - The file being written (used to determine show directory)
 * @param {object} newData - The data to write (must have a .url field to be checked)
 * @returns {string|null} Conflicting filename (basename only), or null if no collision
 */
/**
 * Decide whether a URL-collision should mark the NEW file as duplicateOf the
 * collider. Returns false — i.e. keep the new file PRIMARY — when (a) the new
 * file carries a _duplicateOfCleared breadcrumb from a prior reviewed clear,
 * (b) the new file carries a substantive review body and the collider is a
 * materially thinner (empty/stub) same-URL sibling, or (c) both bodies are
 * substantive but the new file is provably higher quality (named byline or
 * anchored-scorer band) than an Unknown/unanchored collider. Otherwise defer
 * to the collider (historical behavior: the first same-URL file wins).
 *
 * Why (a)/(b): checkUrlCollision returns the first same-URL sibling in
 * readdir order, regardless of which holds the real review. Blindly marking
 * the new file a duplicate buries a real review under an empty
 * byline-explosion stub and re-forms the cluster on every write (much-ado
 * Sarah Crompton re-dupped to an empty alun-hood, 2026-07-05). A body is the
 * only per-file signal that a review actually exists, so the file with the
 * body must stay primary.
 *
 * Why (c): the body-length check alone can't tell two substantive same-URL
 * files apart, so a named/anchored new write can still get buried under an
 * Unknown/unanchored collider that merely happened to exist first — the same
 * pattern task #1338 retro-healed 26 pre-existing pairs of (Death Note
 * WhatsOnStage: named+anchored Alun Hood review vs an Unknown-byline review,
 * both with full text). Reuses shouldFlipDuplicateDirection from
 * duplicate-direction-heal.js so write-time and the post-hoc retro-heal audit
 * can never disagree about which side should be canonical. Role mapping:
 * `newData` plays the "loser" role (about to be subordinated via duplicateOf
 * if this function returns true) and `colliderData` plays the "winner" role
 * (what it would point to) — see the call below.
 *
 * Pure (no I/O) for tests/unit/url-collision-canonical.test.mjs.
 * @param {{fullText?:string,criticName?:string,llmScore?:object}} newData
 * @param {{fullText?:string,criticName?:string,llmScore?:object}|null} colliderData
 * @returns {boolean} true → mark new file duplicate; false → keep new file primary
 */
/**
 * Would marking `thisBasename` as duplicateOf `candidateTarget` complete a
 * duplicateOf cycle of ANY length, not just the direct 2-node case (the
 * collider pointing its duplicateOf back at us — A.duplicateOf=B AND
 * B.duplicateOf=A, and the rebuild then excludes BOTH files, silently
 * dropping the review, 242 corpus-wide, 2026-07-11)? A longer chain is just
 * as real: A already duplicateOf B, B already duplicateOf C, and this write
 * sets C.duplicateOf=A closes A->B->C->A just as surely (Notion #941 washpost
 * 3-cycle: andor-brodeur -> justin-davidson -> michael-andor-brodeur ->
 * andor-brodeur — caught only by the post-hoc audit, never at write time).
 * Delegates the actual walk to scripts/lib/duplicate-cycle.js so write-time
 * refusal and the audit's post-hoc detection can never disagree about what
 * counts as a cycle. Declining to mark leaves the pre-existing chain intact,
 * so exactly one direction survives.
 *
 * Pure (no I/O) — `loadSibling` is injected — for tests/unit/circular-duplicate-pair.test.mjs.
 * @param {string} thisBasename basename of the file being written
 * @param {string|null|undefined} candidateTarget the duplicateOf value about to be set (the collider's basename)
 * @param {(basename: string) => ({duplicateOf?: string}|null)} loadSibling loads a sibling's parsed record by basename
 * @returns {boolean}
 */
function wouldFormDuplicateCycle(thisBasename, candidateTarget, loadSibling) {
  return _wouldFormDuplicateCycleN(thisBasename, candidateTarget, loadSibling);
}

// Body-length thresholds shared by the collision-decision helpers below.
// SUBSTANTIVE: long enough to claim canonical status / be LLM-scoreable.
// NEAR_EMPTY: short enough to hold nothing unique (stub / nulled-by-correction).
const SUBSTANTIVE_BODY_CHARS = 500;
const NEAR_EMPTY_BODY_CHARS = 200;

function shouldMarkUrlCollisionDuplicate(newData, colliderData) {
  // A prior cleanup pass explicitly reviewed this URL collision and cleared it
  // as a false positive (_duplicateOfCleared breadcrumb — e.g. two distinct
  // critics genuinely publishing under one Guardian/BWW article URL). Without
  // this check, ANY later write — even an unrelated field like publishDate —
  // re-flagged the file duplicateOf and silently excluded it from scoring
  // (163 corpus-wide, 2026-07-15). Honor the breadcrumb: never re-mark.
  if (newData && newData._duplicateOfCleared) return false;
  // Can't read the collider → defer to historical behavior (mark duplicate). We
  // only keep the new file primary when we can PROVE the collider is thinner.
  if (!colliderData) return true;
  const newLen = String((newData && newData.fullText) || '').trim().length;
  const colLen = String((colliderData && colliderData.fullText) || '').trim().length;
  // New file has a real body AND the collider is (near-)empty → new file is the
  // canonical; do not mark it duplicate.
  if (newLen >= SUBSTANTIVE_BODY_CHARS && colLen < NEAR_EMPTY_BODY_CHARS) return false;
  // Both bodies substantive — the length check can't resolve it. Fall back to
  // the same named/anchored-beats-Unknown quality signal the retro-heal audit
  // uses: newData is the would-be "loser" (about to point duplicateOf at
  // colliderData, the would-be "winner"); if newData is provably better, keep
  // it primary instead. Gated on BOTH bodies clearing the substance floor —
  // without this, a short named/anchored stub could out-rank a genuinely
  // substantive Unknown-byline collider, inverting the "below the substance
  // floor, don't claim canonical" rule this function enforces everywhere else.
  if (newLen >= SUBSTANTIVE_BODY_CHARS && colLen >= SUBSTANTIVE_BODY_CHARS
      && shouldFlipDuplicateDirection(newData, colliderData)) return false;
  return true;
}

/**
 * Collision decision for a file whose URL was just corrected (urlCorrectedFrom
 * set) — the branch the blanket `!newData.urlCorrectedFrom` skip used to
 * swallow. Same-URL identity is NOT transient (that was only ever true of the
 * body, which maybeUpgradeUrl nulls), so a corrected file adopting a URL a
 * sibling already owns is by definition the newcomer to that URL.
 *
 * Mark duplicateOf ONLY when this file's body is near-empty: it holds nothing
 * unique, so deferring to the same-URL sibling loses nothing (the
 * enormous-crocodile london-theatre--unknown case — maybeUpgradeUrl always
 * leaves the corrected file bodyless). A substantive body means a
 * possibly-legitimate multi-critic review sharing the sibling's URL (88 such
 * corpus files, review probe 2026-08-01) — those are NEVER buried here; the
 * dedicated dedup passes own that call. Unreadable collider → decline (the
 * normal branch's mark-on-unproven default is too aggressive for a file in a
 * transient state).
 *
 * Pure (no I/O) for tests/unit/url-collision-canonical.test.mjs.
 * @param {{fullText?:string,_duplicateOfCleared?:any,assignedScore?:number,aggregatorStars?:string}|null} newData
 * @param {{fullText?:string,assignedScore?:number,aggregatorStars?:string}|null} colliderData
 * @returns {boolean} true → mark corrected file duplicateOf the collider
 */
function shouldMarkPostCorrectionDuplicate(newData, colliderData) {
  if (!newData) return false;
  if (newData._duplicateOfCleared) return false;
  if (!colliderData) return false;
  const newLen = String(newData.fullText || '').trim().length;
  if (newLen >= NEAR_EMPTY_BODY_CHARS) return false;
  // Sole-score guard: a bodyless file can still be the pair's only scored copy
  // (paywalled-star-outlet stubs score via aggregatorStars-fallback — corpus
  // probe found ap--mark-kennedy score 65 vs a scoreless same-URL sibling).
  // Never bury the only score-bearing copy; a sibling with a score, stars, or
  // a scoreable body can stand in, so deferring to it loses nothing.
  const newHasScore = newData.assignedScore != null || newData.aggregatorStars != null;
  const colCanScore = colliderData.assignedScore != null
    || colliderData.aggregatorStars != null
    || String(colliderData.fullText || '').trim().length >= SUBSTANTIVE_BODY_CHARS;
  if (newHasScore && !colCanScore) return false;
  return true;
}

function checkUrlCollision(filePath, newData) {
  if (!newData || !newData.url || typeof newData.url !== 'string') return null;
  const dir = path.dirname(filePath);
  const thisFile = path.basename(filePath);
  let files;
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json' && f !== thisFile);
  } catch {
    return null;
  }
  const normNew = _normalizeUrlForCollision(newData.url);
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      if (data.url && typeof data.url === 'string' && _normalizeUrlForCollision(data.url) === normNew) {
        return f;
      }
    } catch { /* skip unreadable */ }
  }
  return null;
}

// Normalize a URL for collision comparison.
//
// Delegates to review-normalization.normalizeUrl (the project's canonical
// URL-comparison primitive), which handles protocol/www/trailing-slash
// stripping, fragment removal, AMP-suffix strip (added 2026-04-28), and
// the shared tracking-param allowlist (utm_, ref, source, fbclid, etc.).
// Inlining a second normalizer here was the design problem flagged in
// tonight's plan-review — two normalizers drift over time. Single source
// of truth: review-normalization.normalizeUrl.
function _normalizeUrlForCollision(url) {
  // Lazy require to avoid circular dep at module load.
  const { normalizeUrl } = require('./review-normalization');
  return normalizeUrl(url);
}

/**
 * Check whether a URL contains a sequential-digit placeholder pattern that
 * suggests it was fabricated rather than copied from a live page.
 *
 * Motivation: Joe Turner 2009 catalog audit (2026-04-26) found
 * https://www.wsj.com/articles/SB123944876543210987 — a WSJ legacy-ID URL
 * containing both ascending (1239…) and a long descending run (876543210).
 * Eight similar files were identified in the catalog. This function provides
 * a write-time detector so urlPlaceholderSuspect=true is set before the file
 * lands on disk, without blocking the write (false-positive rate unknown).
 *
 * Pattern coverage:
 *  1. WSJ legacy IDs where the SB-prefixed numeric portion contains a
 *     4-digit ascending sequential run (SB1234…, SB2345…, …, SB0123…) OR
 *     a 4-digit descending run (SB9876…, SB8765…, …, SB1098…).
 *     The real test URL SB123944876543210987 matches via descending 9876 run
 *     embedded in the digits (…4876…).
 *  2. Any URL path containing 7+ strictly ascending sequential digits
 *     (1234567 … 1234567890) — common stub tail pattern.
 *  3. Any URL path containing 7+ strictly descending sequential digits
 *     (9876543 … 9876543210) — the Joe Turner WSJ ID contains 876543210.
 *  4. Path that ENDS in any of the above sequences (stub tail).
 *
 * @param {string} url
 * @returns {boolean} true if the URL looks like a placeholder
 */
function hasPlaceholderUrlPattern(url) {
  if (!url || typeof url !== 'string') return false;

  // Pattern 1a: WSJ-style SB-prefixed IDs with a 4-digit ascending sequential run.
  // Matches embedded SB1234…, SB2345…, SB3456…, SB4567…, SB5678…, SB6789…, SB7890…, SB0123…
  const WSJ_ASCENDING = /wsj\.com\/articles\/SB\d{0,8}(?:1234|2345|3456|4567|5678|6789|7890|0123)/i;

  // Pattern 1b: WSJ-style SB-prefixed IDs with a 4-digit DESCENDING sequential run.
  // The Joe Turner fake ID SB123944876543210987 contains "4876" which embeds a
  // descending 4-digit sequence (4→3→2→1 is not matching, but the broader
  // string contains "9876" within "44876"). Capture it via any descending 4-run.
  // Also covers: SB9876…, SB8765…, SB7654…, SB6543…, SB5432…, SB4321…, SB3210…, SB2109…, SB1098…
  const WSJ_DESCENDING = /wsj\.com\/articles\/SB\d{0,8}(?:9876|8765|7654|6543|5432|4321|3210|2109|1098)/i;

  // Pattern 2: Any URL containing 7+ strictly ascending sequential digits.
  // Covers: 1234567, 12345678, 123456789, 1234567890 in any path position.
  const ASCENDING_LONG = /(?:SB)?\d{0,4}(?:1234567|12345678|123456789|1234567890)/i;

  // Pattern 3: Any URL containing 7+ strictly descending sequential digits.
  // The Joe Turner WSJ URL contains 876543210 (9-digit descending run).
  // Covers: 9876543, 87654321, 876543210, 9876543210.
  const DESCENDING_LONG = /(?:9876543(?:210?)?|87654321(?:0)?|76543210|65432109)/i;

  // Pattern 4: Path ending in a sequential run (stub tail pattern).
  const PATH_ASCENDING_TAIL = /\/(?:SB)?\d{0,4}(?:1234567|12345678|123456789|1234567890)\/?(?:[?#].*)?$/i;

  return (
    WSJ_ASCENDING.test(url) ||
    WSJ_DESCENDING.test(url) ||
    ASCENDING_LONG.test(url) ||
    DESCENDING_LONG.test(url) ||
    PATH_ASCENDING_TAIL.test(url)
  );
}

/**
 * Coerce a non-numeric assignedScore into a number, or null it if unparseable.
 *
 * Schmigadoon 2026 shipped the NY Post review with assignedScore="2/4 stars"
 * (string) because schema drift let a raw rating string land in the numeric
 * slot. validate-data.js catches this post-rebuild, but the gate is too late —
 * the bad value had already gone to subscribers. Block it at write time.
 *
 * Recognized patterns (via shared parseRating()): "N/N stars", "N stars",
 * "B+" / letter grades, sentiment words, bare numeric strings. Anything else
 * becomes null + flag, and the caller's stderr shows the coercion.
 *
 * @param {object} data The review-text JSON object (mutated in place).
 * @param {string} [filePath] Optional, only used for log context.
 * @returns {{ changed: boolean, from?: any, to: number|null, reason?: string }}
 */
function coerceAssignedScore(data, filePath) {
  const val = data.assignedScore;
  // Already the right shape (null, undefined, or finite number) — no-op.
  if (val === null || val === undefined) return { changed: false, to: val ?? null };
  if (typeof val === 'number' && Number.isFinite(val)) return { changed: false, to: val };

  const original = val;

  // First preference: originalScoreNormalized is the authoritative 0-100 form
  // that setExtractedScore() already wrote from the extractor's normalizedScore.
  // If it's present and sane, trust it.
  if (
    typeof data.originalScoreNormalized === 'number' &&
    Number.isFinite(data.originalScoreNormalized) &&
    data.originalScoreNormalized >= 0 &&
    data.originalScoreNormalized <= 100
  ) {
    data.assignedScore = data.originalScoreNormalized;
    data._assignedScoreCoercedFrom = original;
    data._assignedScoreCoercedAt = new Date().toISOString();
    return {
      changed: true,
      from: original,
      to: data.originalScoreNormalized,
      reason: 'from-originalScoreNormalized',
    };
  }

  // Second preference: string form that parseRating() understands (stars, grades, etc.).
  if (typeof val === 'string') {
    const parsed = parseRating(val);
    if (
      parsed &&
      !parsed.unparseable &&
      typeof parsed.expected === 'number' &&
      Number.isFinite(parsed.expected)
    ) {
      data.assignedScore = parsed.expected;
      data._assignedScoreCoercedFrom = original;
      data._assignedScoreCoercedAt = new Date().toISOString();
      return {
        changed: true,
        from: original,
        to: parsed.expected,
        reason: `parsed-as-${parsed.type}`,
      };
    }
  }

  // Unrecoverable: null the score and flag for human review so the bad value
  // can't propagate to reviews.json. Rebuild will skip this review.
  data.assignedScore = null;
  data._assignedScoreCoercionFailed = true;
  data._assignedScoreCoercedFrom = original;
  data._assignedScoreCoercedAt = new Date().toISOString();
  data.needsReview = true;
  return { changed: true, from: original, to: null, reason: 'unparseable' };
}

/**
 * Decide whether a poller text-update should be skipped to protect existing data.
 *
 * Joe Turner postmortem A #1, A #16 (2026-04-26): collect-review-texts.js was
 * writing fullText:'' on top of existing non-empty content when its scraper
 * tier returned nothing. The push-action patch (commit 6c34f1ebf7) caught it
 * at push time, but the right place is at the source. This predicate is the
 * source-side gate.
 *
 * Returns { skip, reason } so callers can log a meaningful breadcrumb.
 *
 * @param {object} existingData - Parsed JSON of the existing review file
 * @param {string|null|undefined} newText - The freshly-fetched fullText
 * @returns {{ skip: boolean, reason: string|null }}
 */
/**
 * Decide whether an enrichment script should skip a locked file entirely.
 *
 * Joe Turner postmortem P0 #2 (2026-04-26): safeWriteReview's lockedOverride
 * only protects PROTECTED_FIELDS. Enrichment scripts that mutate
 * NON-PROTECTED fields on locked files (criticName backfill, isSyndicatedDuplicate
 * detection, outletId re-aliasing) need an explicit early-return — the writer
 * guard alone does not save them.
 *
 * Returns { skip, reason } so callers can log a meaningful breadcrumb.
 *
 * @param {object|null|undefined} existingData - Parsed JSON of the existing review file
 * @returns {{ skip: boolean, reason: string|null }}
 */
function shouldSkipLockedEnrichment(existingData) {
  if (!existingData || typeof existingData !== 'object') {
    return { skip: false, reason: null };
  }
  if (existingData._locked === true) {
    return { skip: true, reason: '_locked=true' };
  }
  return { skip: false, reason: null };
}

function shouldSkipPollerUpdate(existingData, newText) {
  const existingTextLen = (existingData && typeof existingData.fullText === 'string')
    ? existingData.fullText.trim().length
    : 0;
  const newTextLen = (typeof newText === 'string') ? newText.trim().length : 0;

  if (existingData && existingData._locked === true && existingTextLen > 0) {
    return { skip: true, reason: `_locked=true with ${existingTextLen}ch existing fullText` };
  }
  if (existingData && existingData.manualContentTier === 'complete' && existingTextLen > 0) {
    return { skip: true, reason: `manualContentTier=complete with ${existingTextLen}ch existing fullText` };
  }
  if (newTextLen === 0 && existingTextLen > 0) {
    return { skip: true, reason: `new text empty; existing fullText is ${existingTextLen}ch` };
  }
  return { skip: false, reason: null };
}

/**
 * Move/rename a review-text file under the lock contract.
 *
 * Refuses to move when the SOURCE is `_locked: true` unless `force: true` is
 * passed. This is the topology-side counterpart to safeWriteReview's
 * lockedOverride: the field-level guard cannot stop a rename, an unlink, or
 * a cross-show MOVE — those operations bypass the writer entirely. This
 * helper closes the gap.
 *
 * Conflict semantics: if `dstPath` already exists, the helper returns
 * `{ skipped: 'conflict', conflictPath }` and DOES NOT touch either file.
 * The caller decides what to do (set data.duplicateOf, flag wrongProduction,
 * etc.). This explicit non-merge eliminates the PR #290 corruption surface
 * where merging into existing dest was silently undone by a downstream
 * write to the original (source) path.
 *
 * Sister-store side effects on a successful rename:
 * 1. data/llm-scores/{srcShow}/{srcFile}.json → {dstShow}/{dstFile}.json
 *    (renamed if present; conflict at sister store is logged + source unlinked).
 * 2. Same-show duplicateTextOf pointers in sibling files referencing the old
 *    basename are rewritten to the new basename. Cross-show pointers become
 *    orphaned (validate-review-texts catches them as missing-target).
 *
 * @param {string} srcPath - Absolute path to the source file
 * @param {string} dstPath - Absolute path the file should land at
 * @param {object} [options]
 * @param {boolean} [options.force=false] - Bypass the source `_locked` check
 * @param {object|null} [options.newData=null] - Optional updated content to
 *   write at dstPath. When omitted, the helper writes the source file's
 *   content verbatim. Pass updated data when migrating cross-show MOVEs that
 *   stamp `movedFrom`/`movedReason`/`showId` fields onto the moved file.
 * @returns {{
 *   wrote: boolean,
 *   renamed?: boolean,
 *   skipped?: 'source-missing'|'source-unreadable'|'locked'|'conflict'|'noop',
 *   conflictPath?: string,
 *   lockedSkipped?: boolean,
 *   sisterStoreMoved?: boolean,
 *   siblingPointersUpdated?: number,
 *   error?: string,
 * }}
 */
function safeRenameReview(srcPath, dstPath, options = {}) {
  const { force = false, newData = null } = options;

  if (!fs.existsSync(srcPath)) {
    return { wrote: false, skipped: 'source-missing' };
  }

  let srcData;
  try {
    srcData = JSON.parse(fs.readFileSync(srcPath, 'utf-8'));
  } catch (e) {
    return { wrote: false, skipped: 'source-unreadable', error: e.message };
  }

  if (srcData && srcData._locked === true && !force) {
    console.warn(`[review-write-guard] Refusing rename of locked file ${path.basename(srcPath)} → ${path.basename(dstPath)}`);
    return { wrote: false, skipped: 'locked', lockedSkipped: true };
  }

  if (path.resolve(srcPath) === path.resolve(dstPath)) {
    return { wrote: false, skipped: 'noop' };
  }

  if (fs.existsSync(dstPath)) {
    return { wrote: false, skipped: 'conflict', conflictPath: dstPath };
  }

  fs.mkdirSync(path.dirname(dstPath), { recursive: true });
  const contentToWrite = (newData && typeof newData === 'object') ? newData : srcData;
  // A file flagged as a duplicate of `dstFile` that is now being renamed ONTO
  // that name (byline identified: outlet--unknown.json → outlet--critic.json)
  // would carry the pointer along and become a duplicate of itself — silently
  // dropped from every rebuild. It IS the canonical file now; strip the pointer.
  const dstBasename = path.basename(dstPath);
  for (const field of ['duplicateOf', 'duplicateTextOf']) {
    if (contentToWrite[field] === dstBasename) {
      delete contentToWrite[field];
      if (field === 'duplicateOf') delete contentToWrite.duplicateReason;
      console.log(`[review-write-guard] stripped self-referential ${field} on rename → ${dstBasename}`);
    }
  }
  // Re-stamp showId to the destination show dir. rebuild-all-reviews groups by
  // data.showId (not by directory), so a cross-show move that keeps the source
  // id verbatim files the review under the WRONG show — and validate-review-
  // texts won't catch it (it derives its key from the directory). The dir name
  // is the show id by corpus layout (same rule as safeWriteReview's backstop);
  // skip dirs whose own name can't be a show id (test/tmp/hidden).
  {
    const dstDirName = path.basename(path.dirname(dstPath));
    if (dstDirName && !dstDirName.startsWith('_') && !dstDirName.startsWith('.')
        && contentToWrite.showId !== dstDirName) {
      if (contentToWrite.showId) {
        console.log(`[review-write-guard] re-stamped showId on rename: "${contentToWrite.showId}" → "${dstDirName}" (${dstBasename})`);
      }
      contentToWrite.showId = dstDirName;
    }
  }
  fs.writeFileSync(dstPath, JSON.stringify(contentToWrite, null, 2) + '\n');
  fs.unlinkSync(srcPath);

  const sister = _updateSisterStoresOnRename(srcPath, dstPath);

  return {
    wrote: true,
    renamed: true,
    sisterStoreMoved: sister.llmScoreMoved,
    sisterStoreConflict: sister.sisterStoreConflict,
    sisterStoreError: sister.sisterStoreError,
    siblingPointersUpdated: sister.pointersUpdated,
  };
}

/**
 * Delete a review-text file under the lock contract.
 *
 * Refuses to delete when the file is `_locked: true` unless `force: true`.
 * Mirrors safeRenameReview's source-side gate. Used by topology operations
 * that delete a redundant file (cleanup-phantom-outlets merge-then-unlink,
 * any future unlink path on review-texts).
 *
 * @param {string} filePath - Absolute path to the file to delete
 * @param {object} [options]
 * @param {boolean} [options.force=false] - Bypass `_locked`
 * @returns {{
 *   wrote: boolean,
 *   unlinked?: boolean,
 *   skipped?: 'source-missing'|'unreadable'|'locked',
 *   lockedSkipped?: boolean,
 *   error?: string,
 * }}
 */
function safeUnlinkReview(filePath, options = {}) {
  const { force = false } = options;

  if (!fs.existsSync(filePath)) {
    return { wrote: false, skipped: 'source-missing' };
  }

  let data = null;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) {
    if (!force) {
      return { wrote: false, skipped: 'unreadable', error: e.message };
    }
    // force=true on a corrupt file: allow unlink (file is already broken).
  }

  if (data && data._locked === true && !force) {
    console.warn(`[review-write-guard] Refusing unlink of locked file ${path.basename(filePath)}`);
    return { wrote: false, skipped: 'locked', lockedSkipped: true };
  }

  // Cascade-clear: any sibling in the same directory whose `duplicateOf`
  // points at this file becomes a dangling reference once we unlink. Clear
  // those references before the unlink so the audit-duplicate-of-url-
  // mismatch gate doesn't flag them later. Lazy-require to avoid a circular
  // import (cascade-clear-duplicate-refs is a leaf, but defensive here).
  const dir = path.dirname(filePath);
  const basename = path.basename(filePath);
  try {
    const { cascadeClearDuplicateRefs } = require('./cascade-clear-duplicate-refs');
    cascadeClearDuplicateRefs(dir, basename);
  } catch { /* best-effort */ }

  fs.unlinkSync(filePath);
  return { wrote: true, unlinked: true };
}

/**
 * Internal: rename the llm-scores sidecar and rewrite same-show
 * duplicateTextOf sibling pointers. Returns a result describing partial
 * failures so callers (and the calling helper's return value) can surface
 * them rather than silently log-and-drop.
 *
 * Sister-store scope notes:
 *   - llm-scores: at data/llm-scores/{showId}/{file}.json. Conflict at the
 *     sister store means BOTH sidecars existed. We MUST NOT silently delete
 *     the loser — that drops scoring data. Instead we surface
 *     `sisterStoreConflict: true` so the caller can log + the operator can
 *     triage. The old sidecar stays in place under the source's filename
 *     until reconciled.
 *   - duplicateTextOf pointer rewrites: ONLY srcDir is scanned. For same-
 *     show renames srcDir === dstDir so siblings get correctly retargeted.
 *     For cross-show MOVE, scanning dstDir would falsely rewrite any
 *     dstDir sibling whose duplicateTextOf coincidentally equals srcFile
 *     (basename collision across shows). Cross-show pointers in srcDir
 *     become orphaned references — left for validate-review-texts to flag.
 *     (Codex ship-check P0 2026-04-29.)
 */
function _updateSisterStoresOnRename(srcPath, dstPath) {
  const srcDir = path.dirname(srcPath);
  const dstDir = path.dirname(dstPath);
  const srcFile = path.basename(srcPath);
  const dstFile = path.basename(dstPath);
  const srcShowId = path.basename(srcDir);
  const dstShowId = path.basename(dstDir);
  const repoRoot = path.resolve(__dirname, '..', '..');

  let llmScoreMoved = false;
  let sisterStoreConflict = false;
  let sisterStoreError = null;
  const oldLlmPath = path.join(repoRoot, 'data', 'llm-scores', srcShowId, srcFile);
  if (fs.existsSync(oldLlmPath)) {
    const newLlmPath = path.join(repoRoot, 'data', 'llm-scores', dstShowId, dstFile);
    try {
      fs.mkdirSync(path.dirname(newLlmPath), { recursive: true });
      if (!fs.existsSync(newLlmPath)) {
        fs.renameSync(oldLlmPath, newLlmPath);
        llmScoreMoved = true;
      } else {
        // CONFLICT: both sidecars exist. Do not silently drop either —
        // surface to caller. Old sidecar stays at oldLlmPath until operator
        // reconciles. (Pre-ship-check this branch silently unlinked old.)
        sisterStoreConflict = true;
        console.warn(`[review-write-guard] llm-scores sidecar conflict — KEEPING BOTH for triage. old=${path.relative(repoRoot, oldLlmPath)} new=${path.relative(repoRoot, newLlmPath)}`);
      }
    } catch (e) {
      sisterStoreError = e.message;
      console.warn(`[review-write-guard] llm-scores sidecar move failed: ${e.message}`);
    }
  }

  let pointersUpdated = 0;
  // Only scan srcDir. For cross-show MOVE, dstDir siblings sharing srcFile
  // basename are coincidental and must NOT be retargeted. Same-show case:
  // srcDir === dstDir so the single scan covers everything.
  if (fs.existsSync(srcDir)) {
    let files;
    try {
      files = fs.readdirSync(srcDir).filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');
    } catch { files = []; }
    for (const f of files) {
      if (f === dstFile && srcDir === dstDir) continue;
      if (f === srcFile) continue;
      const sibPath = path.join(srcDir, f);
      let sibData;
      try {
        sibData = JSON.parse(fs.readFileSync(sibPath, 'utf-8'));
      } catch { continue; }
      if (sibData && sibData.duplicateTextOf === srcFile) {
        sibData.duplicateTextOf = dstFile;
        try {
          fs.writeFileSync(sibPath, JSON.stringify(sibData, null, 2) + '\n');
          pointersUpdated++;
        } catch (e) {
          console.warn(`[review-write-guard] failed to rewrite duplicateTextOf in ${path.relative(repoRoot, sibPath)}: ${e.message}`);
        }
      }
    }
  }

  return { llmScoreMoved, pointersUpdated, sisterStoreConflict, sisterStoreError };
}

module.exports = { safeWriteReview, safeRenameReview, safeUnlinkReview, checkForDataLoss, getEffectiveProtectedFields, checkUrlCollision, shouldMarkUrlCollisionDuplicate, shouldMarkPostCorrectionDuplicate, wouldFormDuplicateCycle, coerceAssignedScore, shouldSkipPollerUpdate, shouldSkipLockedEnrichment, hasPlaceholderUrlPattern, preserveFlaggedFields, PROTECTED_FIELDS, CLEAR_BREADCRUMBS, isIntentionalClear, invalidateWrongProductionAutoClear, isFreshWrongProductionAutoClear: _freshWrongProductionAutoClear, _setShowsCacheForTest };
