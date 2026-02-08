/**
 * Excerpt Validation Module
 *
 * Layer 3: Cross-show excerpt validation (detects excerpts mentioning wrong shows)
 * Layer 4: Tour review excerpt detection (detects touring production language)
 *
 * Designed for use in rebuild-all-reviews.js selectBestExcerpt() pipeline.
 * Operates in dry-run mode by default (logs but doesn't suppress) until
 * DRY_RUN_CROSS_SHOW=false is set.
 */

const path = require('path');
const fs = require('fs');

// --- Layer 3: Cross-Show Validation ---

// Titles that are common English words — NEVER match these as cross-show references
// because they appear naturally in review text (e.g., "the company delivers", "beyond doubt")
const COMMON_WORD_TITLES = new Set([
  // Single common words
  'company', 'doubt', 'network', 'proof', 'sweat', 'closer', 'home', 'nine',
  'cats', 'rent', 'once', 'hair', 'big', 'grease', 'chicago', 'fame',
  'oliver', 'pippin', 'annie', 'dreamgirls', 'carousel', 'contact',
  'curtains', 'follies', 'gypsy', 'tommy', 'ragtime', 'purlie',
  'ruined', 'eclipse', 'topdog', 'wings', 'bent', 'betrayal',
  'lobby', 'hero', 'slave', 'wolf', 'power', 'trouble', 'appropriate',
  'on the town', 'the visit', 'the rose', 'the band',
  // Two-word common phrases
  'war paint', 'the trip', 'the year', 'big fish', 'big river',
  'bright star', 'beautiful', 'holiday', 'parade', 'passion',
  'spring', 'summer', 'stomp', 'sunset', 'cabaret',
  // Theater terms that are also show titles — appear constantly in review text
  'the audience', 'master class', 'the performers', 'the present',
  'the price', 'the real thing', 'all the way', 'rock \'n\' roll',
  'chinglish',
  // Short titles easily embedded in other words/phrases
  'bug', 'job', 'juno', 'fela', 'fun', 'leap', 'loot',
]);

// Minimum title length to consider for matching (chars)
const MIN_TITLE_LENGTH = 8;

let _titleCache = null;

/**
 * Build title → showId map from shows.json (cached after first call)
 * Only includes titles >= MIN_TITLE_LENGTH and not in COMMON_WORD_TITLES
 */
function getMatchableTitles() {
  if (_titleCache) return _titleCache;

  const showsPath = path.join(__dirname, '../../data/shows.json');
  const shows = JSON.parse(fs.readFileSync(showsPath, 'utf8')).shows || [];

  _titleCache = new Map();

  for (const show of shows) {
    const title = show.title;
    if (!title) continue;

    // Skip short titles and common-word titles
    if (title.length < MIN_TITLE_LENGTH) continue;
    if (COMMON_WORD_TITLES.has(title.toLowerCase())) continue;

    // Store with word-boundary regex for accurate matching
    // Escape special regex chars in title
    const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`, 'i');
    _titleCache.set(show.id, { title, regex });
  }

  return _titleCache;
}

/**
 * Check if an excerpt mentions a different show's title without mentioning the current show.
 *
 * @param {string} excerpt - The excerpt text to check
 * @param {string} currentShowId - The show ID this excerpt belongs to
 * @param {string} currentShowTitle - The title of the current show
 * @returns {{ isWrongShow: boolean, mentionedShowId?: string, mentionedTitle?: string }}
 */
function excerptMentionsWrongShow(excerpt, currentShowId, currentShowTitle) {
  if (!excerpt || !currentShowId) return { isWrongShow: false };

  const titles = getMatchableTitles();

  // Check if excerpt mentions current show's title (if so, it's probably fine
  // even if it mentions another show — could be a comparison)
  const currentEscaped = currentShowTitle
    ? currentShowTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    : null;
  const currentRegex = currentEscaped
    ? new RegExp(`\\b${currentEscaped}\\b`, 'i')
    : null;
  const mentionsCurrentShow = currentRegex ? currentRegex.test(excerpt) : false;

  for (const [showId, { title, regex }] of titles) {
    // Skip self
    if (showId === currentShowId) continue;

    // Check if this other show's title appears in the excerpt
    if (regex.test(excerpt)) {
      // If excerpt also mentions current show, it's likely a comparison — allow it
      if (mentionsCurrentShow) continue;

      return {
        isWrongShow: true,
        mentionedShowId: showId,
        mentionedTitle: title
      };
    }
  }

  return { isWrongShow: false };
}

// --- Layer 4: Tour Review Detection ---

const TOUR_EXCERPT_PATTERNS = [
  /\btouring production\b/i,
  /\bnational tour\b/i,
  /\bNorth American tour\b/i,
  /\bfirst national\b/i,
  /\broad company\b/i,
  /\bbus and truck\b/i,
  /\btouring company\b/i,
  /\bon tour\b/i,
];

// Known touring venue names that appear in review excerpts
const TOUR_VENUE_PATTERNS = [
  /\bPantages\b/,
  /\bOrpheum\b/,
  /\bFox Theatre\b/,
  /\bFabulous Fox\b/,
  /\bAhmanson\b/,
  /\bCIBC Theatre\b/,
  /\bCadillac Palace\b/,
  /\bKennedy Center\b/,
  /\bBoston Opera House\b/,
  /\bBuell Theatre\b/,
  /\bSegerstrom\b/,
  /\bDPAC\b/,
  /\bPlayhouse Square\b/,
];

/**
 * Check if an excerpt appears to be from a touring production review.
 *
 * @param {string} excerpt - The excerpt text
 * @returns {{ isTourReview: boolean, signal?: string }}
 */
function isTourReviewExcerpt(excerpt) {
  if (!excerpt) return { isTourReview: false };

  for (const pattern of TOUR_EXCERPT_PATTERNS) {
    if (pattern.test(excerpt)) {
      return { isTourReview: true, signal: pattern.source };
    }
  }

  for (const pattern of TOUR_VENUE_PATTERNS) {
    if (pattern.test(excerpt)) {
      return { isTourReview: true, signal: `venue: ${pattern.source}` };
    }
  }

  return { isTourReview: false };
}

/**
 * Reset the title cache (for testing)
 */
function resetCache() {
  _titleCache = null;
}

module.exports = {
  excerptMentionsWrongShow,
  isTourReviewExcerpt,
  getMatchableTitles,
  resetCache,
  COMMON_WORD_TITLES,
  MIN_TITLE_LENGTH,
};
