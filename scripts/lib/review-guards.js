/**
 * Pure decision functions extracted from the opening night pipeline.
 *
 * These are exported so the test suite can require() and test the REAL logic.
 * The rule: never copy logic into a test file — always require() the real function.
 * If production code changes, the test must be updated. That's the point.
 *
 * See: scripts/test-opening-night-fixes.js
 */

/**
 * Fix #12 — assignedScore skip guard (collect-review-texts.js)
 *
 * Returns true if a review should be skipped during collection because it already has
 * a valid score and sufficient text. This prevents re-collection from destroying live
 * scored reviews by fetching garbage that triggers LLM rejection flags.
 *
 * @param {Object} data - Review data object (from review-texts JSON file)
 * @param {number} reviewFilterSize - Size of the explicit review filter (CONFIG.reviewFilter.size).
 *   When >0, the caller is targeting specific reviews — guard is bypassed.
 */
function shouldSkipScoredReview(data, reviewFilterSize = 0) {
  const textLen = data.fullText ? data.fullText.length : 0;
  return (
    data.assignedScore >= 1 &&
    data.assignedScore <= 100 &&
    textLen >= 100 &&
    reviewFilterSize === 0
  );
}

/**
 * Fix #13 — Revival slug preference (discover-dtli-slugs.js)
 *
 * Given a showId and array of candidate DTLI slug strings, picks the best one.
 * For revival shows (ID has year suffix like -2026), prefers the slug with the
 * highest numeric suffix (e.g. "giant-2" over "giant") — the suffix indicates
 * production order. This prevents old bare slugs from blocking the correct revival slug.
 *
 * @param {string} showId - Our show ID (e.g. "giant-2026", "hamilton")
 * @param {string[]} slugs - Candidate DTLI slug strings (e.g. ["giant", "giant-2"])
 * @returns {string} The best slug
 */
function pickBestDtliSlug(showId, slugs) {
  if (!slugs || slugs.length === 0) return null;
  let best = slugs[0];
  if (slugs.length > 1) {
    const showYearMatch = showId.match(/-(\d{4})$/);
    const showYear = showYearMatch ? parseInt(showYearMatch[1]) : null;
    if (showYear) {
      const withSuffix = slugs.filter(s => /-\d+$/.test(s));
      if (withSuffix.length > 0) {
        best = withSuffix.sort((a, b) => {
          const nA = parseInt((a.match(/-(\d+)$/) || [0, 0])[1]);
          const nB = parseInt((b.match(/-(\d+)$/) || [0, 0])[1]);
          return nB - nA;
        })[0];
      }
    }
  }
  return best;
}

/**
 * Fix #14 — Temporal override for wrongProduction/isFilmTv (content-verifier.js)
 *
 * Reviews published within 30 days of opening night are almost certainly reviewing
 * the current production. If an LLM flags wrongProduction or isFilmTv for a review
 * this close to opening, we downgrade wrongProduction confidence to 'low' and clear
 * isFilmTv entirely. Low confidence prevents fullText nulling.
 *
 * @param {boolean} wpFlag - LLM's wrongProduction flag
 * @param {boolean} filmTvFlag - LLM's isFilmTv flag
 * @param {string} wpConfidence - LLM's confidence level ('high'|'medium'|'low')
 * @param {string|null} openingDate - Show's opening date (YYYY-MM-DD)
 * @param {string|null} publishDate - Review's publish date (YYYY-MM-DD)
 * @returns {{ wpConfidence: string, filmTvFlag: boolean }}
 */
function applyTemporalOverrides(wpFlag, filmTvFlag, wpConfidence, openingDate, publishDate) {
  let resultWpConfidence = wpConfidence;
  let resultFilmTvFlag = filmTvFlag;

  if (openingDate && publishDate) {
    const opening = new Date(openingDate);
    const publish = new Date(publishDate);
    if (!isNaN(opening.getTime()) && !isNaN(publish.getTime())) {
      const daysDiff = Math.abs((publish.getTime() - opening.getTime()) / 86400000);
      if (daysDiff <= 30) {
        if (wpFlag) resultWpConfidence = 'low';
        if (filmTvFlag) resultFilmTvFlag = false;
      }
    }
  }

  return { wpConfidence: resultWpConfidence, filmTvFlag: resultFilmTvFlag };
}

module.exports = { shouldSkipScoredReview, pickBestDtliSlug, applyTemporalOverrides };
