/**
 * isNonReview + substantial-word-count + review-URL-slug coverage bucketing
 * (BRO-3862).
 *
 * The ticket's evidence: a corpus sweep of isNonReview:true files with
 * >=400 words AND a URL whose path reads like a review ("/theatre-
 * review-...", ".../review/...") found ~200 files across nonReviewType
 * none/news/feature/preview/interview/profile/obituary/blog/other — none of
 * which the two existing false-positive audits ever look at:
 *   - scripts/lib/essay-intro-nonreview-fp.js only matches SOFT_NONREVIEW_TYPES
 *     (preview/interview/profile/bio/news_article) with an explicit closing
 *     recommendation phrase — narrow by design (BRO-57), so it silently
 *     passes over 'feature'/'none'/'news' and any review without a "don't
 *     miss"-shaped verdict (the confirmed live miss, Daily Mail/Marmion, was
 *     nonReviewType='feature' and closed on critical analysis, not a stock
 *     recommendation phrase — widening SOFT_NONREVIEW_TYPES to add 'feature'
 *     alone was measured to recover exactly ONE file corpus-wide, so it is
 *     NOT a fix).
 *   - scripts/lib/nonreview-contenttype-wrongshow.js only matches
 *     nonReviewType==='review' (a distinct bug class: real review content,
 *     just of a different show — see that module's header).
 * This module doesn't invent a THIRD auto-clearing predicate for the
 * remainder — the ticket is explicit that the corpus is "too noisy to
 * auto-clear as-is" and any clear is "a one-way trust decision" requiring
 * hand-verification first. What it does is make the corpus MEASURABLE and
 * bucketed, wired into CI (audit-nonreview-slug-coverage.js), so the count
 * is a tracked metric instead of a one-off manual sweep that nobody revisits.
 *
 * 'already-excluded' bucket (added during the 2026-09-21 re-verification):
 * the original 'unaudited' bucket counted files that are ALREADY correctly
 * excluded from reviews.json by a DIFFERENT, established mechanism —
 * wrongShow, wrongProduction, contentVerification.wrongArticle, a
 * garbage-text/invalid contentTier, or a dead-page chrome dump
 * (detectStrongChromeDumpAnywhere, content-quality.js — parked domains,
 * 404s, cookie/nav dumps). None of those need this ticket's attention; they
 * were inflating "unaudited" to look nearly 4x its real size (measured
 * 2026-09-21: 208 raw hits, only 53 not already covered by one of these).
 * Checked BEFORE wrong-show-suspect/essay-intro-fp so a file already
 * excluded by one mechanism doesn't also get counted by another.
 */

'use strict';

const { classifyReviewUrl } = require('./non-review-url-patterns');
const { detectEssayIntroFalsePositive } = require('./essay-intro-nonreview-fp');
const { isReviewTypeWrongShowGap } = require('./nonreview-contenttype-wrongshow');
const { isGarbageContent, isEffectivelyWrongProductionOrShow } = require('./content-quality');
const { isRejectedNonReview } = require('./review-guards');

const MIN_WORD_COUNT = 400;

/**
 * Does this URL's PATH (not host) read like a review slug? Host-level
 * "review" substrings (a domain literally named nystagereview.com) don't
 * count — this is deliberately about the page's own path, mirroring how a
 * human would eyeball a URL and say "yeah, that looks like a review page."
 * classifyReviewUrl() filters out the known non-candidate shapes first
 * (ticketing hosts, roundup hubs, aggregator internal nav, the bare
 * /reviews/ index page the ticket calls out by name) so this predicate
 * doesn't have to re-derive that denylist.
 *
 * @param {string} url
 * @returns {boolean}
 */
function hasReviewUrlSlug(url) {
  if (!url || typeof url !== 'string') return false;
  const classified = classifyReviewUrl(url);
  if (!classified.ok) return false;
  let pathname;
  try { pathname = new URL(url).pathname; } catch { return false; }
  return /review/i.test(pathname);
}

/**
 * Is `data` even in the corpus this ticket scoped: isNonReview:true, a
 * substantial word count, and a review-shaped URL? This is the base filter
 * BEFORE any bucketing — matches the ticket's own "201 isNonReview files
 * with 400+ words and a review URL slug" definition.
 *
 * @param {object} data
 * @returns {boolean}
 */
function isSlugCoverageCandidate(data) {
  if (!data || data.isNonReview !== true) return false;
  const fullText = data.fullText || '';
  if (!fullText) return false;
  const wordCount = data.textWordCount || fullText.split(/\s+/).filter(Boolean).length;
  if (wordCount < MIN_WORD_COUNT) return false;
  return hasReviewUrlSlug(data.url);
}

/**
 * Bucket a candidate into one of the audited classes, or 'unaudited' when
 * no existing predicate covers it. Callers should filter to
 * isSlugCoverageCandidate() first (or rely on this returning null for
 * anything that isn't a candidate at all).
 *
 * @param {object} data
 * @param {string} [showId]
 * @returns {null | 'wrong-show-suspect' | 'essay-intro-fp' | 'unaudited'}
 */
/**
 * Is `data` already excluded from reviews.json by a mechanism OTHER than
 * the bare isNonReview flag this ticket is about? These files don't need
 * BRO-3862 attention — they're correctly gone already, just via a
 * different field. See module header for the corpus-size rationale.
 *
 * Delegates to the SAME canonical predicates the rebuild/gate pipeline uses
 * (CLAUDE.md: "includability predicates must be canonical") rather than
 * re-deriving the logic here — a hand-rolled version drifted from
 * production on its first pass (ship-check adversarial review, BRO-3862):
 *   - isEffectivelyWrongProductionOrShow (content-quality.js) honors
 *     wrongProductionManualClear/wrongProductionCleared/wrongProductionAuto
 *     Cleared/allowEarlyDate/allowCrossMarket/humanReviewedWrongProduction
 *     and wrongShowManualClear — a raw `data.wrongShow === true` check does
 *     not, so it could mark a manually-cleared file "already-excluded" when
 *     the rebuild would actually include it.
 *   - isRejectedNonReview (review-guards.js) already gates wrongArticle on
 *     confidence==='high' and honors the structural-star-score / independent-
 *     excerpt exceptions to a garbage_text/not_a_review rejectionReason —
 *     a raw `contentVerification.wrongArticle === true` or
 *     `rejectionReason === 'garbage_text'` check does neither, so it could
 *     mark a file "already-excluded" when the real pipeline would still
 *     score it.
 *   - isGarbageContent (content-quality.js) is the function that actually
 *     SETS contentTier:'invalid' — it requires no substantial review
 *     content AND the marker not being trailing footer junk before calling
 *     a chrome/cookie/paywall pattern a genuine dump. Calling
 *     detectStrongChromeDumpAnywhere directly (its docstring: "intended
 *     ONLY for callers that have already established the text lacks
 *     substantial review content") skips that precondition and can flag a
 *     real review whose footer happens to say "manage cookie preferences".
 *   Recomputed live from fullText rather than trusting the stored
 *   contentTier field, which may be stale relative to the current pipeline.
 *
 * @param {object} data
 * @returns {boolean}
 */
function isAlreadyExcludedByOtherMechanism(data) {
  const { effectivelyWrongProduction, effectivelyWrongShow } = isEffectivelyWrongProductionOrShow(data);
  if (effectivelyWrongProduction || effectivelyWrongShow) return true;
  if (isRejectedNonReview(data)) return true;
  if (isGarbageContent(data.fullText || '').isGarbage) return true;
  return false;
}

function bucketSlugCoverageHit(data, showId) {
  if (!isSlugCoverageCandidate(data)) return null;
  if (isAlreadyExcludedByOtherMechanism(data)) return 'already-excluded';
  if (isReviewTypeWrongShowGap(data)) return 'wrong-show-suspect';
  if (detectEssayIntroFalsePositive(data, showId)) return 'essay-intro-fp';
  return 'unaudited';
}

module.exports = {
  MIN_WORD_COUNT,
  hasReviewUrlSlug,
  isSlugCoverageCandidate,
  isAlreadyExcludedByOtherMechanism,
  bucketSlugCoverageHit,
};
