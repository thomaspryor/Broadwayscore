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

/**
 * Check if a URL looks like a review for the given show title.
 * Filters out tag pages, author pages, ticket links, etc.
 * Used in site-search-discovery.js to filter URLs returned by section-page scrapers.
 *
 * Title matching: strips non-alphanumeric chars, removes articles + short words (≤2 chars),
 * requires ≥50% of remaining title words to appear in the URL. Fails open (returns true)
 * when no significant title words remain — better to include than miss.
 *
 * @param {string} url - The URL to check
 * @param {string} showTitle - The show title to match against
 * @returns {boolean}
 */
function urlLooksLikeReview(url, showTitle) {
  const lower = url.toLowerCase();
  // Reject non-article URLs
  if (lower.includes('/tag/') || lower.includes('/author/') || lower.includes('/category/')) return false;
  if (lower.includes('/search') || lower.includes('/page/')) return false;
  if (lower.includes('ticket') && !lower.includes('review')) return false;

  // Check if URL contains words from show title
  const titleWords = showTitle.toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !['the', 'and', 'for'].includes(w));

  // Word-boundary match: prevents "tru" matching "trump" or "bug" matching "debug".
  // Boundaries: start/end of string, space, hyphen, slash, period, quote, underscore.
  const wordMatch = (haystack, word) => {
    const escaped = word.replace(/[.*+?${}()|[\]\\]/g, '\\$&');
    return new RegExp('(?:^|[\\s\\-/.\'"_])' + escaped + '(?:$|[\\s\\-/.\'"_])', 'i').test(haystack);
  };
  const matchCount = titleWords.filter(w => wordMatch(lower, w)).length;
  return matchCount >= Math.ceil(titleWords.length * 0.5);
}

/**
 * Date-mismatch guard: detects reviews likely from a prior production.
 *
 * If a review was published more than `thresholdDays` before the show's
 * earliest known date (opening night or first preview), it's almost
 * certainly reviewing a different production.
 *
 * Handles ordinal suffixes in date strings (e.g., "May 10th, 2019").
 *
 * @param {string|null} reviewDateStr - Review publish date string
 * @param {string|null} showEarliestDateStr - Show's earliest date (YYYY-MM-DD)
 * @param {number} thresholdDays - Days before show date to flag (default 90)
 * @returns {boolean} true if review is likely from a wrong production
 */
function isLikelyWrongProduction(reviewDateStr, showEarliestDateStr, thresholdDays = 90) {
  if (!reviewDateStr || !showEarliestDateStr) return false;
  const cleaned = reviewDateStr.replace(/(\d+)(?:st|nd|rd|th)\b/g, '$1');
  const reviewDate = new Date(cleaned);
  const showDate = new Date(showEarliestDateStr);
  if (isNaN(reviewDate.getTime()) || isNaN(showDate.getTime())) return false;
  return (showDate - reviewDate) > thresholdDays * 86400000;
}

/**
 * Detect regional BWW URLs and local paper tour reviews that should not be
 * attributed to the production.
 *
 * For Broadway shows: blocks US regional BWW and local paper tour reviews.
 * For WE/OB shows: blocks US regional BWW (cross-market contamination) but
 * allows BWW westend/london (legitimate WE coverage).
 *
 * @param {string} url - Review URL
 * @param {string} showId - Show ID
 * @returns {boolean} true if the URL indicates a tour/regional review
 */
function isLikelyTourReview(url, showId) {
  if (!url || !showId) return false;

  const lower = url.toLowerCase();
  const isWestEnd = /-west-end/.test(showId) || /-off-west-end/.test(showId);
  const isOffBroadway = /-off-broadway/.test(showId);

  // Regional BWW (city-specific subdirectories)
  const bwwMatch = lower.match(/broadwayworld\.com\/([a-z-]+)\/article\//);
  if (bwwMatch) {
    const city = bwwMatch[1];
    // These are NOT regional — they're main BWW sections
    const nonRegional = ['article', 'off-broadway', 'reviews', 'board', 'columns', 'people', 'video', 'shows'];
    if (nonRegional.includes(city)) { /* not regional, fall through */ }
    else if (isWestEnd || isOffBroadway) {
      // For WE/OB shows: BWW westend and london are legitimate, US cities are not
      const ukCities = ['westend', 'london', 'uk-regional'];
      if (!ukCities.includes(city)) return true;
    } else {
      // For Broadway shows: all regional BWW is suspect
      return true;
    }
  }

  // Local paper tour indicators (Broadway shows only)
  if (!isWestEnd && !isOffBroadway) {
    const tourPatterns = [
      /star-telegram\.com.*fort-worth/i,
      /houstonchronicle\.com/i,
      /seattletimes\.com.*theater.*review/i,
      /dallasvoice\.com/i,
      /wehotimes\.com/i,
      /bocamag\.com/i,
      /cleveland\.com.*entertainment/i,
      /dailycardinal\.com/i,
      /latinlifedenver\.com/i,
      /charlotteledger\.substack\.com/i,
      /orlandoweekly\.com.*broadway-in-orlando/i,
      /mdtheatreguide\.com.*(national-tour|kennedy-center|hippodrome)/i,
      /dailygazette\.com.*nippertown.*proctors/i,
      /berkshireedge\.com.*proctors/i,
      /lansingcitypulse\.com/i,
    ];
    return tourPatterns.some(pattern => pattern.test(url));
  }

  return false;
}

/**
 * Detect roundup/aggregator URLs that shouldn't be treated as individual reviews.
 * Returns { isRoundup: true, reason: string } or { isRoundup: false }.
 */
function isRoundupUrl(url) {
  if (!url) return { isRoundup: false };

  // The Stage review-round-ups section
  if (/thestage\.co\.uk\/review-round-ups\//i.test(url)) {
    return { isRoundup: true, reason: 'The Stage review-round-ups page' };
  }

  // WestEndTheatre.com reviews pages (aggregator roundups, not individual reviews)
  if (/westendtheatre\.com\/.*\/reviews\//i.test(url)) {
    return { isRoundup: true, reason: 'WestEndTheatre.com aggregator roundup page' };
  }

  // LBO review roundups (aggregate other critics, not original reviews)
  if (/londonboxoffice\.co\.uk\/.*review-roundup/i.test(url)) {
    return { isRoundup: true, reason: 'LBO review roundup page' };
  }

  // NOTE: Do NOT add generic roundup URL patterns (e.g. /review-roundup/ in BWW URLs).
  // Many legitimate individual critic reviews are SOURCED from roundup pages —
  // the URL points to the roundup where the review was discovered, but the review
  // itself has specific critic/outlet attribution and should count as an original review.
  // Only flag site-specific patterns where the roundup PAGE is being treated as a review.

  return { isRoundup: false };
}

/**
 * Detect URL/venue mismatches that suggest wrong production.
 * Checks if the review URL mentions a different venue than expected.
 *
 * @param {string} url - Review URL
 * @param {string} showVenue - Expected venue from shows.json
 * @param {string} showCategory - Show category (west-end, broadway, etc.)
 * @returns {{ isMismatch: boolean, reason?: string }}
 */
function isVenueMismatch(url, showVenue, showCategory) {
  if (!url || !showVenue) return { isMismatch: false };

  // Only check WE shows — Broadway venue matching is different
  if (showCategory !== 'west-end' && showCategory !== 'off-west-end') return { isMismatch: false };

  // Strip hostname so we only match URL path (avoids false positives from domain names)
  const urlPath = url.replace(/https?:\/\/[^/]+/, '').toLowerCase();

  // Each entry: [urlPattern, venueName, venueMatchPattern]
  // urlPattern matches the URL path; venueMatchPattern matches the show's actual venue.
  // If the URL matches but the venue does NOT match, it's a mismatch.
  const VENUE_CHECKS = [
    [/national-theatre|(?:^|[-/])dorfman(?:[-/]|$)|(?:^|[-/])lyttelton(?:[-/]|$)|(?:^|[-/])olivier-theatre/, 'National Theatre', /national theatre|dorfman|lyttelton|olivier theatre/i],
    [/chichester-festival|chichester-theatre/, 'Chichester Festival Theatre', /chichester/i],
    [/menier-chocolate/, 'Menier Chocolate Factory', /menier/i],
    [/donmar-warehouse/, 'Donmar Warehouse', /donmar/i],
    [/(?:^|[-/])almeida-theatre|[-/]almeida(?:[-/]|$)/, 'Almeida Theatre', /almeida/i],
    [/young-vic(?:[-/]|$)/, 'Young Vic', /young vic/i],
    [/(?:^|[-/])bridge-theatre/, 'Bridge Theatre', /bridge theatre/i],
    [/royal-court(?:-theatre)?/, 'Royal Court', /royal court/i],
    [/rose-theatre-kingston/, 'Rose Theatre Kingston', /rose theatre/i],
    [/waterloo-east/, 'Waterloo East Theatre', /waterloo east/i],
    [/hampstead-theatre/, 'Hampstead Theatre', /hampstead/i],
    [/bush-theatre/, 'Bush Theatre', /bush theatre/i],
  ];

  for (const [urlPattern, venueName, venueMatch] of VENUE_CHECKS) {
    if (urlPattern.test(urlPath)) {
      // Skip "bridge-theatre" matching "cambridge-theatre" (substring false positive)
      if (venueName === 'Bridge Theatre' && /cambridge/i.test(url)) continue;
      if (!venueMatch.test(showVenue)) {
        return { isMismatch: true, reason: 'URL mentions ' + venueName + ' but show venue is ' + showVenue };
      }
    }
  }

  return { isMismatch: false };
}

/**
 * Detect when a review URL's slug clearly names a different show than expected.
 * Catches cases where SERP discovery filed a review under the wrong show directory.
 *
 * @param {string} url - Review URL
 * @param {string} showTitle - Expected show title from shows.json
 * @returns {{ isMismatch: boolean, reason?: string, urlTitle?: string }}
 */
function isUrlTitleMismatch(url, showTitle) {
  if (!url || !showTitle) return { isMismatch: false };

  // Extract the likely show-title slug from the URL path
  // Common patterns: /review-TITLE-venue/, /TITLE-review/, /review/TITLE/
  const urlPath = url.replace(/https?:\/\/[^/]+/, '').toLowerCase();

  // Normalize show title to URL-slug form for comparison
  const titleSlug = showTitle.toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

  // Extract key words from show title (3+ char, non-common)
  const STOP_WORDS = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'review', 'theatre', 'theater', 'musical', 'play', 'london', 'broadway', 'west', 'end', 'new', 'york']);
  const titleWords = titleSlug.split('-').filter(w => w.length >= 3 && !STOP_WORDS.has(w));

  if (titleWords.length === 0) return { isMismatch: false };

  // Check if ANY significant title word appears in the URL path
  const matchCount = titleWords.filter(w => urlPath.includes(w)).length;
  const matchRate = matchCount / titleWords.length;

  // If zero title words match AND the URL path is long enough to contain a show name,
  // this is likely a wrong-show URL
  if (matchRate === 0 && urlPath.length > 30) {
    return { isMismatch: true, reason: 'URL contains none of the show title words (' + titleWords.join(', ') + ')' };
  }

  return { isMismatch: false };
}

module.exports = { shouldSkipScoredReview, pickBestDtliSlug, applyTemporalOverrides, urlLooksLikeReview, isLikelyWrongProduction, isLikelyTourReview, isRoundupUrl, isVenueMismatch, isUrlTitleMismatch };
