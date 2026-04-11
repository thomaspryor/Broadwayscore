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
  if (lower.includes('/search') || lower.includes('/page/') || lower.includes('/obituar')) return false;
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
  // Short titles (1-3 words) need ALL words to match — prevents "Shaw" in "Becky Shaw"
  // matching Fiona Shaw, George Bernard Shaw, etc. Longer titles can afford partial matches.
  const minMatch = titleWords.length <= 3
    ? titleWords.length
    : Math.ceil(titleWords.length * 0.5);
  return matchCount >= minMatch;
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

/**
 * Like urlLooksLikeReview but ALSO accepts a match against the article title/H1.
 *
 * Critics often use creative review titles that don't repeat the show name in the URL —
 * Theater Pizzazz Ron Fassler's DoaS review URL is "hes-back-but-has-willy-loman-ever-left-us"
 * with no "death-of-a-salesman" in the URL slug. The strict urlLooksLikeReview rejected
 * the legit review on opening night.
 *
 * Resolution order:
 *   1. If options.trustedSource === true, accept (used by BWW Review Roundup extractor
 *      where the manual curation is the trusted signal).
 *   2. URL still has rejected patterns (/tag/, /author/, /ticket without /review): reject.
 *   3. URL slug matches the show title via urlLooksLikeReview: accept.
 *   4. articleTitle exists and contains enough title words: accept.
 *   5. Otherwise reject.
 *
 * @param {string} url - Review URL
 * @param {string} showTitle - Show title to match against
 * @param {string|null} articleTitle - Optional article H1 / og:title
 * @param {Object} [options]
 * @param {boolean} [options.trustedSource=false] - Bypass for trusted aggregators
 * @returns {boolean}
 *
 * Refs: memory/project_doas_opening_night_issues.md issue #6
 */
function urlOrTitleLooksLikeReview(url, showTitle, articleTitle, options = {}) {
  if (!url) return false;
  // 1. trustedSource bypass (BWW Roundup curation) — but still check URL is article-shaped
  const lower = url.toLowerCase();
  // Reject obviously non-article URLs even with trustedSource (defense in depth)
  if (lower.includes('/tag/') || lower.includes('/author/') || lower.includes('/category/')) return false;
  if (lower.includes('/search') || lower.includes('/page/') || lower.includes('/obituar')) return false;
  if (lower.includes('ticket') && !lower.includes('review')) return false;

  if (options.trustedSource === true) return true;

  // 2. Try the strict slug check first (cheaper)
  if (urlLooksLikeReview(url, showTitle)) return true;

  // 3. Fall back to article title match if provided
  if (articleTitle && typeof articleTitle === 'string' && articleTitle.trim().length > 0) {
    // Reuse urlLooksLikeReview's word-matching by treating articleTitle as if it were a URL
    // This gives us free word-boundary checking and the same significant-word filter.
    if (urlLooksLikeReview(articleTitle, showTitle)) return true;
  }

  return false;
}

/**
 * Returns true if a wrongShow file should be locked against URL re-assignment
 * because both the existing file's critic and the incoming review's critic
 * normalize to "unknown."
 *
 * The DoaS Apr 9-10 postmortem (#13) showed an RSS feed loop where
 * variety--unknown.json kept getting new wrong URLs assigned to it because:
 *   1. RSS discovery couldn't extract a critic name (criticName = "Unknown")
 *   2. The existing file was already wrongShow=true (from a prior bad URL)
 *   3. The incoming review key (outletId + "unknown") matched the existing key
 *   4. The "wrongShow + URL change" replace branch fired, wiping the wrongShow
 *      flag and stamping a new (also wrong) URL
 *   5. Next cycle: repeat with another wrong URL
 *
 * Outlet+"unknown" is too weak an identity match to claim "same review, just a
 * new URL." When BOTH sides are unknown-critic, refuse the URL re-assignment
 * and preserve the existing file as-is. Site search and SERP layers can still
 * discover the correct URL with a NAMED critic, which falls into the existing
 * unknown→named upgrade path (gather-reviews.js:2511) — that's not blocked.
 *
 * @param {Object|null} existing - Existing review data on disk
 * @param {Object|null} incoming - New review data being merged
 * @returns {boolean} true if the URL re-assignment should be blocked
 *
 * Refs: memory/project_doas_opening_night_issues.md issue #13
 */
function isWrongShowUnknownLocked(existing, incoming) {
  if (!existing || typeof existing !== 'object') return false;
  if (!incoming || typeof incoming !== 'object') return false;
  if (existing.wrongShow !== true) return false;
  const existingCritic = (existing.criticName || '').trim().toLowerCase();
  const incomingCritic = (incoming.criticName || '').trim().toLowerCase();
  const isUnknown = (c) => c === '' || c === 'unknown' || c === 'unnamed';
  return isUnknown(existingCritic) && isUnknown(incomingCritic);
}

/**
 * Centralized check for whether the wrong-production audit should skip a review file.
 *
 * Returns true if any of the three "human-verified positive" overrides is set:
 *   - humanReviewedWrongProduction === false (explicit human verification)
 *   - wrongProductionManualClear === true
 *   - wrongProductionOverride === true
 *
 * Use this at every site in rebuild-all-reviews.js that writes wrongProduction = true.
 * Without it, CV-pre-pass and other guards re-flag human-verified files (the DoaS Apr 9-10
 * bug class — see memory/project_doas_opening_night_issues.md issue #10).
 *
 * Strict equality is intentional: the override is the literal value `false`, not just
 * any falsy value. A missing/null/undefined humanReviewedWrongProduction means "not yet
 * human-verified" and the audit should run normally.
 *
 * @param {Object|null} data - Review data object (from review-texts JSON file)
 * @returns {boolean} true if the audit should skip this file
 */
function shouldSkipWrongProductionAudit(data) {
  if (!data || typeof data !== 'object') return false;
  return (
    data.humanReviewedWrongProduction === false ||
    data.wrongProductionManualClear === true ||
    data.wrongProductionOverride === true
  );
}

/**
 * Returns true if the show is a revival of an earlier-titled production.
 *
 * Revival = another show in shows.json shares the same `title` (or `canonicalTitle`)
 * but a different show ID. This is more reliable than year-suffix regex because TodayTix
 * IDs use varied suffixes: `-2026`, `-2`, no suffix at all (e.g. `giant-2`, `death-of-a-salesman`).
 *
 * Used by the revival heuristic gate in content-quality.js — when a review's text mentions
 * actors/details from a prior production of the same title, the LLM should NOT trip
 * "different show mentioned" because the prior production IS the same play, just a
 * different cast/year.
 *
 * @param {string} showId - The show ID being checked (e.g. "death-of-a-salesman-2026")
 * @param {Array} shows - Array of show records (typically from shows.json)
 * @returns {boolean} true if at least one OTHER show shares the same canonical title
 */
function isRevivalByCanonicalTitle(showId, shows) {
  if (!showId || !Array.isArray(shows) || shows.length === 0) return false;
  const target = shows.find(s => s && s.id === showId);
  if (!target) return false;
  const targetTitle = (target.canonicalTitle || target.title || '').toLowerCase().trim();
  if (!targetTitle) return false;
  for (const s of shows) {
    if (!s || s.id === showId) continue;
    const t = (s.canonicalTitle || s.title || '').toLowerCase().trim();
    if (t === targetTitle) return true;
  }
  return false;
}

/**
 * Show-mention heuristic guard.
 *
 * The heuristic show-mention check (validateShowMentioned) is a fast, fragile
 * fallback for when LLM verification was skipped or unavailable. It checks
 * whether the show title appears in the article body. The check has two
 * well-known failure modes:
 *
 *   (1) Paywalled outlets (Times UK, FT, Telegraph, NYT) often return only
 *       the lede + first paragraphs, which may use a metaphorical opening
 *       and never name the show. The collector then nulls fullText and the
 *       review is silently dropped from scoring.
 *
 *   (2) The collector previously derived the title from the showId
 *       (e.g. "dracula-west-end-2025" → "dracula west end") rather than the
 *       canonical title in shows.json ("Dracula"). For multi-word slugs,
 *       this caused validateShowMentioned to look for the wrong string.
 *
 * This guard codifies the rules that should govern WHEN the heuristic is
 * allowed to fire and what to do about prior runs that already left damage:
 *
 *   - The text must be substantive enough for the heuristic to be reliable
 *     (≥250 words AND ≥1500 chars). Below that, the lede may legitimately
 *     omit the title and we should defer to LLM verification or aggregator
 *     scores instead of nulling fullText.
 *
 *   - If the review is alreadyScored (has a valid 1-100 assignedScore from
 *     a trusted aggregator), the heuristic must NOT null fullText. The score
 *     is the source of truth; the heuristic only flags for human review.
 *     Additionally, this branch must CLEAR any stale showNotMentioned /
 *     wrongFullText damage from prior runs (before the alreadyScored guard
 *     existed) so the file recovers automatically.
 *
 *   - The canonical title from shows.json should be preferred over the
 *     showId-derived title.
 *
 * @param {Object} review - Review file data
 * @param {string} cleanedText - Text after cleanText() has run
 * @param {number} cleanedWordCount - Word count of cleanedText
 * @param {{ valid: boolean, confidence: string, reason?: string }} showCheck
 *   - Result of validateShowMentioned() (or equivalent)
 * @returns {{ action: 'skip' | 'flag-needs-review' | 'null-text', reason?: string, repairStaleFlags: boolean }}
 *   - 'skip': context is too thin OR title was found — do nothing
 *   - 'flag-needs-review': set needsReview=true, leave fullText alone, and clear
 *     any stale showNotMentioned / wrongFullText / restore fullText if it was nulled
 *   - 'null-text': move fullText → wrongFullText and null fullText (legacy behavior,
 *     only applies to unscored reviews with substantive text)
 */
function evaluateShowMentionGuard(review, cleanedText, cleanedWordCount, showCheck) {
  // Context-too-thin gate: heuristic is unreliable on short paywalled excerpts
  // where the lede may legitimately omit the show title (metaphorical opening,
  // anecdotal lede, performance-focused lede, etc.).
  const charCount = (cleanedText || '').length;
  const HEURISTIC_MIN_CHARS = 1500;
  const HEURISTIC_MIN_WORDS = 250;
  if (charCount < HEURISTIC_MIN_CHARS || cleanedWordCount < HEURISTIC_MIN_WORDS) {
    return {
      action: 'skip',
      reason: `context too thin (${cleanedWordCount} words / ${charCount} chars < ${HEURISTIC_MIN_WORDS}w/${HEURISTIC_MIN_CHARS}c)`,
      repairStaleFlags: false,
    };
  }

  // showCheck either passed or wasn't decisive — nothing to do
  if (!showCheck || showCheck.valid || showCheck.confidence !== 'high') {
    return { action: 'skip', repairStaleFlags: false };
  }

  // alreadyScored guard: never destroy a review that has a trusted aggregator score.
  // Also clear any stale damage from prior runs (before this guard existed).
  const alreadyScored = !!(review.assignedScore && review.assignedScore >= 1 && review.assignedScore <= 100);
  if (alreadyScored) {
    return {
      action: 'flag-needs-review',
      reason: showCheck.reason || 'show title not found in text',
      repairStaleFlags: true,
    };
  }

  return {
    action: 'null-text',
    reason: showCheck.reason || 'show title not found in text',
    repairStaleFlags: false,
  };
}

/**
 * Pick the canonical show title for heuristic checks.
 *
 * Prefers the title from shows.json (e.g. "Dracula") over the showId-derived
 * fallback ("dracula west end") because the latter contains market suffixes
 * that the article body never uses.
 *
 * @param {string} showId - Show ID (e.g. "dracula-west-end-2025")
 * @param {Object|null} showMeta - Show entry from shows.json (or null if unavailable)
 * @returns {string} Title to pass to validateShowMentioned
 */
function pickShowTitleForHeuristic(showId, showMeta) {
  if (showMeta && typeof showMeta.title === 'string' && showMeta.title.trim().length > 0) {
    return showMeta.title;
  }
  return (showId || '').replace(/-\d{4}$/, '').replace(/-/g, ' ');
}

/**
 * Build a keyword set for "does this text look like it's about this show" checks.
 *
 * Used as a final-mile guard before auto-restoring a wrongFullText → fullText.
 * The rebuild auto-clear trusts a prior LLM verification (verifiedBy=llm:gemini,
 * isValid:true), but LLMs hallucinate isValid:true on garbage pages — browser-update
 * prompts, paywall walls, sidebar story lists, even wrong-show content. Without
 * this final check, the auto-clear restores junk as the canonical fullText.
 *
 * Keywords include: full lowercased title, individual title words ≥3 chars (minus
 * stopwords), top 5 cast surnames (≥4 chars), top 3 director surnames, venue words.
 *
 * @param {Object} show - shows.json entry
 * @returns {Set<string>} Lowercased keywords
 */
function buildShowKeywordSet(show) {
  const keywords = new Set();
  if (!show) return keywords;
  // Stopwords excluded from EVERY source (title words, cast surnames, creative team
  // surnames, venue words). Some shows have corrupted creative team data with sentence
  // fragments like "Gordon Greenberg is working with" → last word "with" would pollute
  // the keyword set otherwise.
  const STOP = new Set([
    'the','and','for','with','play','show','musical','broadway','london','westend','west','end','theatre','theater','from','that','this',
    // Common verb/preposition fragments that creep in from corrupted creative team data
    'working','person','people','from','have','will','been','were','their','about','into','onto','some','also','only','more','most','than','then','when','what','which','where','they','them','some','some',
  ]);
  const passes = (w) => w.length >= 3 && !STOP.has(w);
  const passesLong = (w) => w.length >= 4 && !STOP.has(w);

  const realTitle = (show.title || '').toLowerCase();
  if (realTitle.length >= 4) keywords.add(realTitle);
  for (const w of realTitle.replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)) {
    if (passes(w)) keywords.add(w);
  }
  for (const c of (show.cast || []).slice(0, 5)) {
    if (!c.name) continue;
    const last = c.name.split(/\s+/).pop().toLowerCase();
    if (passesLong(last)) keywords.add(last);
  }
  for (const c of (show.creativeTeam || []).slice(0, 3)) {
    if (!c.name) continue;
    const last = c.name.split(/\s+/).pop().toLowerCase();
    if (passesLong(last)) keywords.add(last);
  }
  if (show.venue) {
    for (const w of show.venue.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)) {
      if (w.length >= 5 && !STOP.has(w) && w !== 'theatre' && w !== 'theater') keywords.add(w);
    }
  }
  return keywords;
}

/**
 * Check if `text` mentions any keyword from `keywordSet`.
 * Long keywords (≥5 chars) use substring match; short keywords (<5) use word-boundary
 * regex to avoid "rent" matching "current" or "win" matching "winning".
 *
 * @param {string} text - Text to scan
 * @param {Set<string>} keywordSet - Keywords from buildShowKeywordSet()
 * @returns {string|null} The first matched keyword, or null if none matched
 */
function findShowKeywordInText(text, keywordSet) {
  if (!text || !keywordSet || keywordSet.size === 0) return null;
  const lower = text.toLowerCase();
  for (const k of keywordSet) {
    if (k.length >= 5) {
      if (lower.includes(k)) return k;
    } else {
      const re = new RegExp('\\b' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
      if (re.test(text)) return k;
    }
  }
  return null;
}

/**
 * Check whether LLM-verified content also passes the keyword-mention gate.
 *
 * Why: LLM contentVerification hallucinates `isValid:true` ~48% of the time on
 * garbage pages (browser-update prompts, paywall walls, sidebar story lists,
 * wrong-show content). Trusting the LLM verdict alone has corrupted scoring
 * multiple times. See feedback_llm_verifier_hallucinates.md + the 15 ship-check
 * cases in Notion card 33f637c5-416f-814c-9102-f10a0849d986.
 *
 * Contract:
 *   - Returns `null` when the check is not applicable (no LLM verification,
 *     too-short text, no keywords available, LLM already flagged wrongArticle).
 *     Callers should fall through.
 *   - Returns `{ passed, matchedKeyword, keywordsChecked }` otherwise.
 *     `passed:false` means the LLM said valid but no show-identifying keyword
 *     appears in the text — high-confidence hallucination signal.
 *
 * Used by:
 *   - scripts/rebuild-all-reviews.js (auto-clear of stale showNotMentioned)
 *   - scripts/collect-review-texts.js (write-path quarantine)
 *   - scripts/audit-llm-hallucinations.js (corpus sweep)
 *
 * @param {Object} show - shows.json entry for the show this review belongs to
 * @param {string} text - Text to validate (fullText or wrongFullText)
 * @param {Object} cv - contentVerification object from the review file
 * @returns {null | { passed: boolean, matchedKeyword: string|null, keywordsChecked: string[] }}
 */
function checkLlmVerificationAgainstKeywords(show, text, cv) {
  if (!cv || typeof cv.verifiedBy !== 'string' || !cv.verifiedBy.startsWith('llm:')) return null;
  if (cv.isValid !== true) return null;
  if (cv.wrongArticle === true) return null;
  if (!text || typeof text !== 'string' || text.length < 100) return null;
  const keywords = buildShowKeywordSet(show);
  if (keywords.size === 0) return null;
  const matched = findShowKeywordInText(text, keywords);
  return {
    passed: matched !== null,
    matchedKeyword: matched,
    keywordsChecked: Array.from(keywords),
  };
}

// ---------------------------------------------------------------------------
// SERP retry guard — splits by incompleteReason
// ---------------------------------------------------------------------------
//
// Empirical context (2026-04-11): 13,905 review files are stuck with
// incompleteReason in {no_url, wrong_content, fabricatedEntry}. 13,483 are
// `wrong_content` — a URL was found but content verification rejected it.
// Re-SERPing these with the same deterministic query (site:outlet + title +
// year window) returns the same wrong URL (url-discovery.js:533 skips the
// current URL and picks sibling pages). 83% are on shows closed >180 days
// ago where the SERP date window is frozen.
//
// Strategy:
//   - `no_url` (422 files): timestamp-based cooldown via serpRetryAfter
//   - `wrong_content` (13,483 files): hard retry cap via serpRetryCount +
//     serpDiscoveryAbandoned. Closed-old (>180d) gets 0 retries — once a file
//     with a frozen SERP window is known bad, it's always bad.
//
// The guard is PURE: query functions (shouldRetryUrlDiscovery) decide whether
// to SERP, compute functions (recordSerpAttempt) return the new state the
// caller must write to the review file. All I/O happens in the caller.
//
// New protected fields on review files (synced in review-write-guard.js +
// push-review-texts action.yml PROTECTED list):
//   - serpRetryAfter (ISO timestamp — don't SERP before this)
//   - serpRetryCount (int — cumulative SERP attempts for this file)
//   - serpDiscoveryAbandoned (bool — permanent gate, only cleared manually)
//
// See: sprint-plan-serp-cost-reduction.md, /second-opinion review

const DAY_MS = 86400000;

// Max SERP retries for `wrong_content` reviews keyed by show lifecycle.
// closedOld = 0 because the SERP window is frozen and retries are futile.
// openWindow = 3 because outlet content is still churning during the
// 14-day (BW) / 21-day (WE/OB) opening window and new URLs may be indexed.
const MAX_RETRIES_WRONG_CONTENT = Object.freeze({
  previews: 2,
  openWindow: 3,
  openRecent: 1,
  openMature: 1,
  closedRecent: 1,
  closedOld: 0,
  unknown: 1,
});

// Cooldown between SERP attempts (for `no_url` and for `wrong_content` while
// still under MAX_RETRIES). Short during opening windows (hourly poller needs
// fresh signal), long for closed shows (SERP results frozen).
const COOLDOWN_MS = Object.freeze({
  previews: 24 * 3600 * 1000,     // 24h
  openWindow: 12 * 3600 * 1000,   // 12h
  openRecent: 3 * DAY_MS,          // 3 days
  openMature: 14 * DAY_MS,         // 14 days
  closedRecent: 30 * DAY_MS,       // 30 days
  closedOld: 90 * DAY_MS,          // 90 days
  unknown: 7 * DAY_MS,             // 7 days (safe default)
});

/**
 * Classify a show into a lifecycle bucket for SERP retry decisions.
 *
 * Buckets:
 *   - 'previews'     — status=='previews' OR openingDate is in the future
 *   - 'openWindow'   — open, within 14d (BW) / 21d (WE/OB/OWE) of opening
 *   - 'openRecent'   — open, within 90d of opening
 *   - 'openMature'   — open, >90d since opening
 *   - 'closedRecent' — closed ≤180 days ago
 *   - 'closedOld'    — closed >180 days ago
 *   - 'unknown'      — missing status/openingDate/closingDate (safe default)
 *
 * @param {Object|null} show - shows.json entry
 * @returns {'previews'|'openWindow'|'openRecent'|'openMature'|'closedRecent'|'closedOld'|'unknown'}
 */
function classifyLifecycle(show) {
  if (!show || typeof show !== 'object') return 'unknown';
  const status = show.status || 'unknown';
  const now = Date.now();

  if (status === 'closed') {
    if (!show.closingDate) return 'unknown';
    const closedMs = new Date(show.closingDate).getTime();
    if (isNaN(closedMs)) return 'unknown';
    const daysClosed = (now - closedMs) / DAY_MS;
    return daysClosed > 180 ? 'closedOld' : 'closedRecent';
  }

  if (status === 'previews') return 'previews';

  // open / unknown-but-has-opening
  if (!show.openingDate) return 'unknown';
  const openedMs = new Date(show.openingDate).getTime();
  if (isNaN(openedMs)) return 'unknown';
  const daysOpen = (now - openedMs) / DAY_MS;

  if (daysOpen < 0) return 'previews'; // opening date in future ⇒ still previews
  const category = show.category || '';
  const isWEorOB = category === 'west-end' || category === 'off-west-end' || category === 'off-broadway';
  const openWindowDays = isWEorOB ? 21 : 14;
  if (daysOpen <= openWindowDays) return 'openWindow';
  if (daysOpen <= 90) return 'openRecent';
  return 'openMature';
}

/**
 * Decide whether a review should be re-SERPed for URL discovery.
 *
 * Returns { shouldRetry, reason, nextAttemptAt?, updates? }. The `updates`
 * field is a state patch the caller MUST write to the review file even when
 * shouldRetry is false — specifically when we just crossed the max-retries
 * threshold and need to record serpDiscoveryAbandoned so the next run
 * short-circuits without re-evaluating.
 *
 * Reasons the gate can return:
 *   - 'not_gated'           — incompleteReason is not no_url/wrong_content/fabricated, allow retry
 *   - 'abandoned'           — serpDiscoveryAbandoned is already true, never retry
 *   - 'max_retries_reached' — just hit max; caller should apply updates and skip
 *   - 'cooldown'            — serpRetryAfter is in the future, skip until then
 *   - 'no_url_retry'        — proceed with SERP
 *   - 'wrong_content_retry' — proceed with SERP (still under max, cooldown elapsed)
 *
 * @param {Object|null} show - shows.json entry
 * @param {Object} review - Review data object
 * @returns {{ shouldRetry: boolean, reason: string, nextAttemptAt?: string, updates?: Object }}
 */
function shouldRetryUrlDiscovery(show, review) {
  if (!review || typeof review !== 'object') return { shouldRetry: true, reason: 'not_gated' };

  const ir = review.incompleteReason;
  const isNoUrl = ir === 'no_url';
  const isWrongContent = ir === 'wrong_content';
  const isFabricated = !!review.fabricatedEntry;

  // Not in a gated state → let callers proceed (e.g. collector-flagged
  // wrongShow retries via existing wrongShowRetryAt path are not this gate's
  // responsibility).
  if (!isNoUrl && !isWrongContent && !isFabricated) {
    return { shouldRetry: true, reason: 'not_gated' };
  }

  // Permanent gate — once set, only a human unsets.
  if (review.serpDiscoveryAbandoned === true) {
    return { shouldRetry: false, reason: 'abandoned' };
  }

  const lifecycle = classifyLifecycle(show);
  const count = typeof review.serpRetryCount === 'number' ? review.serpRetryCount : 0;

  // wrong_content: hard retry cap
  if (isWrongContent) {
    const max = MAX_RETRIES_WRONG_CONTENT[lifecycle] ?? 1;
    if (count >= max) {
      return {
        shouldRetry: false,
        reason: 'max_retries_reached',
        updates: { serpDiscoveryAbandoned: true },
      };
    }
  }

  // Cooldown gate (applies to both no_url and wrong_content under max)
  if (review.serpRetryAfter) {
    const after = new Date(review.serpRetryAfter).getTime();
    if (!isNaN(after) && Date.now() < after) {
      return {
        shouldRetry: false,
        reason: 'cooldown',
        nextAttemptAt: review.serpRetryAfter,
      };
    }
  }

  // Allow retry — tag reason for logging
  if (isWrongContent) return { shouldRetry: true, reason: 'wrong_content_retry' };
  return { shouldRetry: true, reason: isFabricated ? 'fabricated_retry' : 'no_url_retry' };
}

/**
 * Compute the state updates to apply to a review file AFTER a SERP attempt.
 *
 * Call this whether the SERP call succeeded or failed — the retry count and
 * cooldown must advance either way, or a perpetually-null SERP response
 * would never trigger abandonment.
 *
 * Returns { serpRetryCount, serpRetryAfter?, serpDiscoveryAbandoned? } — a
 * patch the caller merges into the review file before writing.
 *
 * @param {Object|null} show - shows.json entry
 * @param {Object} review - Review data object (pre-update)
 * @returns {Object} Patch to apply
 */
function recordSerpAttempt(show, review) {
  if (!review || typeof review !== 'object') return {};

  const ir = review.incompleteReason;
  const isNoUrl = ir === 'no_url' || !!review.fabricatedEntry;
  const isWrongContent = ir === 'wrong_content';
  if (!isNoUrl && !isWrongContent) return {};

  const prevCount = typeof review.serpRetryCount === 'number' ? review.serpRetryCount : 0;
  const newCount = prevCount + 1;
  const updates = { serpRetryCount: newCount };

  const lifecycle = classifyLifecycle(show);

  // wrong_content: check if this attempt just hit the cap → abandon
  if (isWrongContent) {
    const max = MAX_RETRIES_WRONG_CONTENT[lifecycle] ?? 1;
    if (newCount >= max) {
      updates.serpDiscoveryAbandoned = true;
      return updates;
    }
  }

  // Still have retries → set next cooldown
  const cooldown = COOLDOWN_MS[lifecycle] ?? (7 * DAY_MS);
  updates.serpRetryAfter = new Date(Date.now() + cooldown).toISOString();

  return updates;
}

module.exports = {
  shouldSkipScoredReview,
  pickBestDtliSlug,
  applyTemporalOverrides,
  urlLooksLikeReview,
  isLikelyWrongProduction,
  isLikelyTourReview,
  isRoundupUrl,
  isVenueMismatch,
  isUrlTitleMismatch,
  shouldSkipWrongProductionAudit,
  isRevivalByCanonicalTitle,
  urlOrTitleLooksLikeReview,
  isWrongShowUnknownLocked,
  evaluateShowMentionGuard,
  pickShowTitleForHeuristic,
  buildShowKeywordSet,
  findShowKeywordInText,
  checkLlmVerificationAgainstKeywords,
  classifyLifecycle,
  shouldRetryUrlDiscovery,
  recordSerpAttempt,
  // Exported for test assertions
  MAX_RETRIES_WRONG_CONTENT,
  COOLDOWN_MS,
};
