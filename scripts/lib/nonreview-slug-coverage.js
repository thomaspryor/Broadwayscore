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
 */

'use strict';

const { classifyReviewUrl } = require('./non-review-url-patterns');
const { detectEssayIntroFalsePositive } = require('./essay-intro-nonreview-fp');
const { isReviewTypeWrongShowGap } = require('./nonreview-contenttype-wrongshow');

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
function bucketSlugCoverageHit(data, showId) {
  if (!isSlugCoverageCandidate(data)) return null;
  if (isReviewTypeWrongShowGap(data)) return 'wrong-show-suspect';
  if (detectEssayIntroFalsePositive(data, showId)) return 'essay-intro-fp';
  return 'unaudited';
}

module.exports = {
  MIN_WORD_COUNT,
  hasReviewUrlSlug,
  isSlugCoverageCandidate,
  bucketSlugCoverageHit,
};
