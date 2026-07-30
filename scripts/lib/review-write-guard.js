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

// Fields that represent collected/scored data and must not be silently erased.
// KEEP IN SYNC with .github/actions/push-review-texts/action.yml PROTECTED array.
const PROTECTED_FIELDS = [
  'assignedScore',
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
  'wrongProductionAutoCleared',
  'wrongProductionAutoClearedAt',
  'wrongProductionReason',
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
  'manualContentTier',
  'designation',
  'isCriticsPick',
  'duplicateOf',
  'duplicateReason',
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

const CLEAR_BREADCRUMBS = {
  duplicateOf: (d) => !_isEmptyValue(d.duplicateClearReason),
  duplicateReason: (d) => !_isEmptyValue(d.duplicateClearReason),
  wrongProduction: _wrongProductionCleared,
  wrongProductionNote: _wrongProductionCleared,
  wrongProductionReason: _wrongProductionCleared,
  wrongShow: _wrongShowCleared,
  wrongShowReason: _wrongShowCleared,
  wrongShowNote: _wrongShowCleared,
  wrongFullText: _wrongArticleCleared,
  wrongAttribution: _wrongArticleCleared,
  originalScore: (d) => d.originalScoreCleared === true,
  originalScoreSource: (d) => d.originalScoreCleared === true,
  originalScoreNormalized: (d) => d.originalScoreCleared === true,
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
        if (existingIsReal && (incomingIsEmpty || lockedOverride)) {
          if (newData[field] !== existingVal) {
            newData[field] = existingVal;
            preserved.push(field);
            if (lockedOverride && !incomingIsEmpty) lockedSkipped = true;
          }
        }
      }

      // If merge mode, also keep any existing fields not in newData
      if (merge) {
        for (const [key, val] of Object.entries(existing)) {
          if (newData[key] === undefined) {
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
  // Skip if the URL is currently mid-correction (urlCorrectedFrom set) — the
  // post-correction state may differ from the URL we're comparing against, and
  // we don't want to lock in a duplicate flag based on transient state.
  if (!force && newData.url && !newData.urlCorrectedFrom) {
    const collider = checkUrlCollision(filePath, newData);
    if (collider) {
      let colliderData = null;
      try {
        colliderData = JSON.parse(fs.readFileSync(path.join(path.dirname(filePath), collider), 'utf-8'));
      } catch { /* unreadable collider — fall back to marking dup (historical behavior) */ }
      if (wouldFormDuplicateCycle(path.basename(filePath), colliderData)) {
        // The collider already points its duplicateOf at us — marking us dup of
        // it would form an A↔B 2-cycle that excludes BOTH files from the rebuild
        // (242 corpus-wide, 2026-07-11). Decline to mark; we are the canonical
        // the collider defers to. If we were previously (wrongly) marked dup of
        // this same collider, clear it now with a breadcrumb so the push-restore
        // exception (isIntentionalClear) doesn't resurrect the cycle.
        console.warn(`[review-write-guard] URL collision: ${path.basename(filePath)} shares URL with ${collider}, but ${collider} already points back at us — keeping primary to avoid a duplicateOf cycle`);
        if (newData.duplicateOf === collider) {
          newData.duplicateClearReason = `auto-cleared at write: refusing duplicateOf cycle with ${collider} (it already points back at us)`;
          newData.duplicateOf = null;
          newData.duplicateReason = null;
        }
      } else if (shouldMarkUrlCollisionDuplicate(newData, colliderData)) {
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
        // newData carries the real review body and the collider is a thin/empty
        // same-URL stub. Marking newData duplicate here BURIES the real review
        // under the stub and re-forms a byline-explosion cluster on every write
        // (much-ado Sarah Crompton → alun-hood, 2026-07-05). Keep it primary.
        console.warn(`[review-write-guard] URL collision: ${path.basename(filePath)} shares URL with ${collider} but has the substantive body — keeping primary`);
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
 * collider. Returns false — i.e. keep the new file PRIMARY — only when (a) the
 * new file carries a _duplicateOfCleared breadcrumb from a prior reviewed
 * clear, or (b) the new file carries a substantive review body and the
 * collider is a materially thinner (empty/stub) same-URL sibling. Otherwise
 * defer to the collider (historical behavior: the first same-URL file wins).
 *
 * Why: checkUrlCollision returns the first same-URL sibling in readdir order,
 * regardless of which holds the real review. Blindly marking the new file a
 * duplicate buries a real review under an empty byline-explosion stub and
 * re-forms the cluster on every write (much-ado Sarah Crompton re-dupped to an
 * empty alun-hood, 2026-07-05). A body is the only per-file signal that a review
 * actually exists, so the file with the body must stay primary.
 *
 * Pure (no I/O) for tests/unit/url-collision-canonical.test.mjs.
 * @param {{fullText?:string}} newData
 * @param {{fullText?:string}|null} colliderData
 * @returns {boolean} true → mark new file duplicate; false → keep new file primary
 */
/**
 * Would marking `thisBasename` as duplicateOf the collider form a 2-cycle?
 * True when the collider ALREADY points its duplicateOf back at this file — i.e.
 * the collider has declared US canonical. Marking us duplicate of it in turn
 * makes A.duplicateOf=B AND B.duplicateOf=A, and the rebuild then excludes BOTH
 * files, silently dropping the review (242 corpus-wide, 2026-07-11). This is the
 * A↔B analogue of the self-referential auto-clear at ~line 528 — the write-guard
 * broke the 1-cycle but not the 2-cycle. Break it at write time by declining to
 * mark: the collider stays pointing at us, so exactly one direction survives.
 *
 * Pure (no I/O) for tests/unit/circular-duplicate-pair.test.mjs.
 * @param {string} thisBasename basename of the file being written
 * @param {{duplicateOf?:string}|null} colliderData parsed collider record
 * @returns {boolean}
 */
function wouldFormDuplicateCycle(thisBasename, colliderData) {
  return !!(colliderData && colliderData.duplicateOf === thisBasename);
}

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
  if (newLen >= 500 && colLen < 200) return false;
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

module.exports = { safeWriteReview, safeRenameReview, safeUnlinkReview, checkForDataLoss, getEffectiveProtectedFields, checkUrlCollision, shouldMarkUrlCollisionDuplicate, wouldFormDuplicateCycle, coerceAssignedScore, shouldSkipPollerUpdate, shouldSkipLockedEnrichment, hasPlaceholderUrlPattern, PROTECTED_FIELDS, CLEAR_BREADCRUMBS, isIntentionalClear };
