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
  // Place names and common nouns that are also show titles
  'broadway', 'brooklyn', 'hamilton', 'innocence', 'barrymore',
  'brothers', 'strangers', 'the women', 'the children', 'the life',
  'the first', 'music is', 'the supporting cast',
  'the producers', 'bullets over broadway',
  // Common phrases / genre terms that are show titles
  'all over', 'best friend', 'a broadway musical', 'charlotte',
  'ballroom', 'liberation', 'romantic comedy', 'the father',
  'lombardi', 'the motherf**ker with the hat',
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
  // Strip trailing punctuation from title before building regex — chars like ! break \b
  const titleForMatch = currentShowTitle
    ? currentShowTitle.replace(/[^\w]+$/, '')
    : null;
  const currentEscaped = titleForMatch
    ? titleForMatch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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
  /\bon tour(?! with)\b/i,
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

// Forward-looking tour mentions (planned/upcoming tours, not reviews of live tours).
// A Broadway review that ends with "a national tour is planned" should NOT be
// excluded as a tour review. Beaches 2026-04-22 + Rocky Horror 2026-04-23 postmortem #18.
const TOUR_FORWARD_TENSE_PATTERNS = [
  /\b(?:national\s+|uk\s+|us\s+|north\s+american\s+)?tour\s+(?:is|will\s+be|will|has\s+been|is\s+being|is\s+set|is\s+slated|is\s+expected)\s+(?:planned|announced|scheduled|slated|launched|booked|set|expected|coming|on\s+the\s+way|to\s+(?:launch|begin|start|open|hit|embark|follow|tour))/i,
  /\b(?:planned|announced|scheduled|slated|upcoming|forthcoming|future|prospective|proposed)\s+(?:national\s+|uk\s+|us\s+|north\s+american\s+)?tour\b/i,
  /\btour\s+(?:starts|begins|opens|kicks\s+off|launches|heads|set\s+to\s+(?:launch|begin|start|open|embark))\s+(?:in\s+\d{4}|later|next|soon|this\s+(?:fall|winter|spring|summer|year))/i,
  /\bto\s+(?:embark\s+on|launch|begin|start|commence|mount|hit\s+the\s+road\s+on)\s+a\s+(?:national\s+|uk\s+|us\s+|north\s+american\s+)?tour\b/i,
  /\b(?:announcing|announced|launching|launch|plans?\s+(?:for|a))\s+(?:a\s+)?(?:national\s+|uk\s+|us\s+|north\s+american\s+)?tour\b/i,
  /\btour\s+(?:in|beginning|opening|starting|launching|set\s+for)\s+(?:20\d{2})\b/i,
  /\bwill\s+tour\b/i,
];

// Past-tense / in-progress markers — confirm this IS a tour review
const TOUR_PAST_TENSE_PATTERNS = [
  /\b(?:saw|caught|watched|attended|experienced|witnessed|reviewed)\s+(?:the\s+)?(?:national\s+|uk\s+|us\s+|north\s+american\s+)?tour\b/i,
  /\b(?:on|during|at|from)\s+(?:its|the)\s+(?:national\s+|uk\s+|us\s+|north\s+american\s+)?tour\b/i,
  /\btour\s+(?:opened|began|started|arrived|settled|landed|stops?|has\s+arrived|is\s+now|continues|is\s+currently|played|comes|came|has\s+come)\b/i,
  /\btoured\b/i,
  /\b(?:currently|now)\s+(?:on|touring)\b/i,
  /\bthis\s+(?:national\s+|uk\s+|us\s+|north\s+american\s+)tour\b/i,
];

/**
 * Returns true if a tour keyword appears only in forward-looking contexts
 * (planned/upcoming tour) with no past-tense/in-progress tour signal.
 * Indicates a Broadway review mentioning a future tour, not a review of the tour itself.
 *
 * @param {string} excerpt
 * @returns {boolean}
 */
function hasOnlyForwardTenseTourMention(excerpt) {
  if (!excerpt) return false;
  const hasForward = TOUR_FORWARD_TENSE_PATTERNS.some(p => p.test(excerpt));
  if (!hasForward) return false;
  const hasPast = TOUR_PAST_TENSE_PATTERNS.some(p => p.test(excerpt));
  return !hasPast;
}

/**
 * Check if an excerpt appears to be from a touring production review.
 *
 * @param {string} excerpt - The excerpt text
 * @returns {{ isTourReview: boolean, signal?: string, forwardTenseOnly?: boolean }}
 */
function isTourReviewExcerpt(excerpt) {
  if (!excerpt) return { isTourReview: false };

  // Venue patterns are unambiguous — check first (forward-tense carve-out does NOT apply)
  for (const pattern of TOUR_VENUE_PATTERNS) {
    if (pattern.test(excerpt)) {
      return { isTourReview: true, signal: `venue: ${pattern.source}` };
    }
  }

  // Tour keyword patterns — skip when only forward-tense context is present
  const matched = TOUR_EXCERPT_PATTERNS.find(p => p.test(excerpt));
  if (matched) {
    if (hasOnlyForwardTenseTourMention(excerpt)) {
      return { isTourReview: false, forwardTenseOnly: true, signal: matched.source };
    }
    return { isTourReview: true, signal: matched.source };
  }

  return { isTourReview: false };
}

// --- Film/TV Review Detection ---

// Phrases that strongly indicate a film/TV/streaming review (not live theater)
const FILM_TV_PATTERNS = [
  /\bstreaming on\b/i,
  /\bon Netflix\b/i,
  /\bon Disney\+/i,
  /\bon Disney Plus\b/i,
  /\bon HBO\b/i,
  /\bon Amazon Prime\b/i,
  /\bon Hulu\b/i,
  /\bon Apple TV/i,
  /\bcinematography\b/i,
  /\bfilmed version\b/i,
  /\bfilm adaptation\b/i,
  /\bmovie adaptation\b/i,
  /\bmovie version\b/i,
  /\bon the big screen\b/i,
  /\bin theaters now\b/i,
  /\bin cinemas\b/i,
];

// Phrases that confirm live theater context (presence = NOT a film review)
const THEATER_CONTEXT_PATTERNS = [
  /\bstage\b/i,
  /\btheatre?\b/i,
  /\bBroadway\b/i,
  /\bcurtain call\b/i,
  /\bintermission\b/i,
  /\bopening night\b/i,
  /\bstanding ovation\b/i,
  /\bthe musical\b/i,
  /\borchestra\b/i,
  /\bmezzanine\b/i,
];

/**
 * Check if text appears to be from a film/TV/streaming review rather than live theater.
 * Requires 2+ film/TV signals AND zero theater signals to flag — high precision.
 *
 * @param {string} text - Review text (typically first 600 chars of fullText)
 * @returns {{ isFilmTv: boolean, signals?: string[], filmCount?: number, theaterCount?: number }}
 */
function isFilmTvReview(text) {
  if (!text || text.length < 100) return { isFilmTv: false };

  const filmMatches = FILM_TV_PATTERNS.filter(p => p.test(text));
  const theaterMatches = THEATER_CONTEXT_PATTERNS.filter(p => p.test(text));

  if (filmMatches.length >= 2 && theaterMatches.length === 0) {
    return {
      isFilmTv: true,
      signals: filmMatches.map(p => p.source),
      filmCount: filmMatches.length,
      theaterCount: 0
    };
  }

  return { isFilmTv: false };
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
  isFilmTvReview,
  hasOnlyForwardTenseTourMention,
  getMatchableTitles,
  resetCache,
  COMMON_WORD_TITLES,
  MIN_TITLE_LENGTH,
};
