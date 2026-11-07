'use strict';

/**
 * Pure tagging logic for scripts/update-commercial-data.js's
 * fetchGrossesAnalysisPost() — separated from the network fetch calls so
 * the tier-selection/tagging decision is unit-testable without mocking
 * HTTP (2026-07-19, S1-T6 of the commercial-model-accuracy sprint plan).
 *
 * Three tiers, tried in order by the caller:
 *   1. author-scoped search (author:Boring_Waltz_9545)
 *   2. author's own profile/submissions feed
 *   3. NEW — generic r/Broadway search, no author filter (plan-review
 *      finding: tiers 1+2 return null on any week the primary Redditor
 *      doesn't post, silently losing that week's signal)
 *
 * Tier 3's match is NOT held to the same trust level as tiers 1/2 — an
 * untrusted author's post could be a joke thread, a meta-discussion about
 * the primary poster's absence, or genuinely wrong data. Per the project's
 * "never mark recouped: true without citation" rule, tier-3 results are
 * tagged `sourceConfidence: 'unverified-fallback'` so the caller routes
 * them through commercial-pending-review.json instead of writing directly.
 */

const WEEK_ENDING_RE = /Week Ending (\d{1,2}\/\d{1,2}\/\d{4})/i;

/**
 * @param {object} post — a raw Reddit post `data` object (title, selftext,
 *   permalink, created_utc, author)
 * @param {1|2|3} tier — which tier found this post
 * @returns {object} the tagged result shape fetchGrossesAnalysisPost returns
 */
function buildGrossesPostResult(post, tier) {
  const title = post.title || '';
  const weekMatch = title.match(WEEK_ENDING_RE);
  const result = {
    selftext: post.selftext || '',
    title,
    weekEnding: weekMatch ? weekMatch[1] : null,
    permalink: post.permalink,
    createdUtc: post.created_utc,
    author: post.author || null,
  };
  if (tier === 3) {
    result.sourceConfidence = 'unverified-fallback';
  }
  return result;
}

module.exports = { buildGrossesPostResult, WEEK_ENDING_RE };
