/**
 * text-gap-classify.js — one pure function that says WHY a review-text file is
 * not complete, in classes the nightly recovery work can act on (zero-gap plan
 * section 1). Built on classifyIncompleteReason (the same decision rebuild
 * writes to incompleteReason), never beside it, so the metric and the pipeline
 * cannot disagree about a failed fetch.
 *
 * Pure: no file or network access. The caller supplies the failed-fetches
 * entry, the outlet registry entry and the show's dates.
 *
 * Order (first match wins):
 *   EXCLUDED, COMPLETE, TERMINAL, FALSE_TRUNCATION_SUSPECT, then the fetch
 *   evidence in the order classifyIncompleteReason applies it (NO_URL, URL_DEAD,
 *   URL_WRONG_PAGE, PAYWALL_PAGE/GARBAGE_PAGE, DEFERRED, BLOCKED), then the text
 *   itself (SHORT_UNVERIFIED, PAYWALL_TRUNCATED, TRUNCATED_OTHER), then
 *   NEVER_FETCHED (URL, no body: includes the excerpt/stub tiers), and UNCLASSIFIED for anything that falls through.
 *
 * Deviations from the plan's table, on purpose:
 *   - soft_404 is DEFERRED, not URL_DEAD: failed-fetch-policy.js lists it in
 *     NON_EVIDENCE_REASONS (the page answered 200; it says nothing about the URL).
 *   - FALSE_TRUNCATION_SUSPECT has no word minimum. The tier classifier upgrades
 *     these at any length; the "Short text" tier reason is what excludes real
 *     capsules, and that is checked directly.
 *   - isNonReview files are EXCLUDED (the plan's section 1 says so) although the
 *     section 0 baseline of 8,365 counted them as open; the metric reports that
 *     count separately (nonReviewIncomplete) so the two definitions reconcile.
 *   - ENGINE_BUG needs the engine ledger (Phase 2) and is not produced here.
 */

'use strict';

const { classifyIncompleteReason } = require('./incomplete-reason');
const { effectiveFailureReason, isNonEvidenceFailure } = require('./failed-fetch-policy');
const { hasExcerpt } = require('./excerpt-fields');
const { stripKnownTrailers } = require('./trailer-signatures');

const GAP_CLASSES = Object.freeze([
  'EXCLUDED',
  'COMPLETE',
  'TERMINAL',
  'FALSE_TRUNCATION_SUSPECT',
  'SHORT_UNVERIFIED',
  'PAYWALL_TRUNCATED',
  'TRUNCATED_OTHER',
  'NO_URL',
  'URL_DEAD',
  'URL_WRONG_PAGE',
  'PAYWALL_PAGE',
  'GARBAGE_PAGE',
  'BLOCKED',
  'DEFERRED',
  'NEVER_FETCHED',
  'UNCLASSIFIED',
]);

// Classes that are not gaps.
const CLOSED_CLASSES = Object.freeze(['EXCLUDED', 'COMPLETE', 'TERMINAL']);

const RECENT_WINDOW_DAYS = 730;
const DAY_MS = 86400000;

// Truncation signals that a page trailer alone can cause. Any other signal
// (paywall prompt, bot stub, mid-article cut) means a real truncation.
const TRAILER_ONLY_SIGNALS = new Set(['no_ending_punctuation', 'has_footer_junk']);
const BLOCKED_FETCH_REASONS = new Set(['all_tiers_failed', 'fetch_error', 'all_tiers_timeout']);

function ms(value) {
  const t = Date.parse(value || '');
  return Number.isFinite(t) ? t : null;
}

/**
 * Recency of a show: 'recent' when it opened (else started previews) within the
 * last 730 days or later. A show with neither date counts as recent: an unknown
 * date must not hide a gap from the recent view. `dateKnown` tells the caller
 * how many such shows there are.
 * @param {{openingDate?:string, previewsStartDate?:string}|null|undefined} show
 * @param {number} nowMs
 * @returns {{recency:'recent'|'historic', dateKnown:boolean}}
 */
function recencyOf(show, nowMs) {
  const t = ms(show && show.openingDate) ?? ms(show && show.previewsStartDate);
  if (t == null) return { recency: 'recent', dateKnown: false };
  return { recency: t >= nowMs - RECENT_WINDOW_DAYS * DAY_MS ? 'recent' : 'historic', dateKnown: true };
}

function endsLikeASentence(s) {
  return /[.!?"'")\]]$/.test(s) || /[.!?][”’]$/.test(s);
}

/**
 * Stored tier is truncated, yet the only thing wrong is a known page trailer
 * (or a curly closing quote): the classifier will upgrade it at the next
 * rebuild. A classifier bug, not a missing article.
 */
function isFalseTruncationSuspect(review) {
  if (review.contentTier !== 'truncated') return false;
  const text = String(review.fullText || '').trim();
  if (!text) return false;
  if (/^Short text/i.test(review.contentTierReason || '')) return false;
  const signals = Array.isArray(review.truncationSignals) ? review.truncationSignals : [];
  if (signals.some((s) => !TRAILER_ONLY_SIGNALS.has(s))) return false;
  const stripped = stripKnownTrailers(text, review.outletId).trim();
  const trailerRemoved = stripped !== text;
  const curlyEnd = /[.!?][”’]$/.test(text);
  return (trailerRemoved || curlyEnd) && endsLikeASentence(stripped);
}

/** A stored HTTP status that says the url's article is gone. */
function isDeadHttpStatus(status) {
  return status === 404 || status === 410;
}

function noUrlSubclass(review, outletInfo) {
  if (outletInfo && outletInfo.accessModel === 'defunct') return 'PRINT_OR_DEFUNCT';
  return hasExcerpt(review) ? 'AGG_REF' : 'BARE';
}

// One validity predicate (gap-terminal.validateTerminal): a stale, unapproved,
// url-changed or recent-show record is not terminal.
function hasTerminalRecord(review, recency = null) {
  return require('./gap-terminal').validateTerminal(review, { recency }).valid;
}

/**
 * @param {object} review parsed review-text file
 * @param {object|null} [ffEntry] failed-fetches.json row for this file
 * @param {object} [ctx]
 * @param {object|null} [ctx.outletInfo] outlet-registry entry (accessModel)
 * @param {object|null} [ctx.show] shows.json record (dates)
 * @param {number} [ctx.nowMs] defaults to Date.now()
 * @returns {{gapClass:string, subclass:string|null, open:boolean, recency:'recent'|'historic', dateKnown:boolean, incompleteReason:string|null, tier:string|null}}
 */
function classifyTextGap(review, ffEntry = null, ctx = {}) {
  if (!review || typeof review !== 'object') throw new TypeError('classifyTextGap: review object required');
  const nowMs = ctx.nowMs ?? Date.now();
  const { recency, dateKnown } = recencyOf(ctx.show, nowMs);
  const done = (gapClass, subclass = null, incompleteReason = null) => ({
    gapClass, subclass, open: !CLOSED_CLASSES.includes(gapClass), recency, dateKnown, incompleteReason,
    tier: review.contentTier || null,
  });

  // Not a gap: other flows own these files.
  const wrongShowLive = review.wrongShow && !require('./review-guards').wrongShowExplicitlyCleared(review);
  if (review.duplicateOf) return done('EXCLUDED', 'duplicate');
  if (wrongShowLive) return done('EXCLUDED', 'wrongShow');
  // A human-cleared flag is not an exclusion (same carve-outs as review-guards' includability checks).
  const wrongProductionLive = review.wrongProduction
    && !(review.wrongProductionManualClear === true || review.wrongProductionOverride === true || review.humanReviewedWrongProduction === false);
  if (wrongProductionLive) return done('EXCLUDED', 'wrongProduction');
  if (review.isRoundupArticle) return done('EXCLUDED', 'roundup');
  if (review.isNonReview) return done('EXCLUDED', 'nonReview');
  // A row the deleted LLM 'web-search' step invented (url 404, no text, its
  // own excerpt). The rebuild, the collector and coverage-holes already skip
  // it; counting it as an open gap sent 169 of them to subscriber browsers
  // nightly (BRO-7171 weak-outlet audit 2026-11-09).
  if (review.fabricatedEntry === true) return done('EXCLUDED', 'fabricated');
  // Complete is closed, but a leftover failed-fetches row is surfaced (metric.completeWithFailedFetchRow).
  if (review.contentTier === 'complete') return done('COMPLETE', ffEntry ? 'with_failed_fetch_row' : null);
  if (hasTerminalRecord(review, dateKnown ? recency : null)) return done('TERMINAL', review.textUnrecoverable.reason);

  if (isFalseTruncationSuspect(review)) return done('FALSE_TRUNCATION_SUSPECT');

  const r = classifyIncompleteReason(review, ffEntry);
  const reason = r ? r.incompleteReason : null;
  const ffReason = ffEntry ? effectiveFailureReason(ffEntry) : '';

  if (reason === 'url_dead') return done('URL_DEAD', ffReason, reason);
  // The outlet answered 404/410 for THIS url (rediscover-review-urls Phase 2
  // HEAD check, or the gap engine's logged-in browser / free refetch). The
  // field is url-bound: url-change-invariant clears it when the url moves.
  // Without this the engine kept re-fetching dead urls through the
  // subscriber browser (Stage 4: 31 WaPo, 16 WSJ, 12 New Yorker, 5 NYT) and
  // never planned ARCHIVE / url rediscovery for them.
  if (review.url && isDeadHttpStatus(review.httpStatus)) return done('URL_DEAD', `http_${review.httpStatus}`, reason);
  if (reason === 'url_content_mismatch') return done('URL_WRONG_PAGE', null, reason);
  if (ffReason === 'garbage_content') {
    return reason === 'paywall' ? done('PAYWALL_PAGE', null, reason) : done('GARBAGE_PAGE', 'garbage_content', reason);
  }
  if (reason === 'no_url' || !review.url) return done('NO_URL', noUrlSubclass(review, ctx.outletInfo), reason);
  // Our own spend or code decision, not evidence about the URL.
  if (reason === 'route_capped' || reason === 'code_error' || isNonEvidenceFailure(ffReason)) {
    return done('DEFERRED', ffReason || reason, reason);
  }
  if (BLOCKED_FETCH_REASONS.has(ffReason)) return done('BLOCKED', ffReason, reason);

  // Text exists: judge it.
  const tier = review.contentTier;
  if (tier === 'invalid') return done('GARBAGE_PAGE', 'invalid_tier', reason);
  if (tier === 'truncated' || tier === 'excerpt' || tier === 'stub') {
    if (tier === 'truncated' && /^Short text/i.test(review.contentTierReason || '')) {
      return done('SHORT_UNVERIFIED', null, reason);
    }
    if (reason === 'paywall' || reason === 'bot_blocked') return done('PAYWALL_TRUNCATED', reason, reason);
    // An excerpt/stub tier holds no fetched body (every such file in the corpus
    // has an empty fullText): the URL has a page nobody has read yet.
    if (tier !== 'truncated') return done('NEVER_FETCHED', reason === 'not_attempted' ? 'never_scraped' : 'no_text_after_fetch', reason);
    return done('TRUNCATED_OTHER', tier, reason);
  }

  if (reason === 'not_attempted') return done('NEVER_FETCHED', 'never_scraped', reason);
  return done('UNCLASSIFIED', null, reason);
}

module.exports = {
  classifyTextGap,
  recencyOf,
  isFalseTruncationSuspect,
  GAP_CLASSES,
  CLOSED_CLASSES,
  RECENT_WINDOW_DAYS,
};
