/**
 * Content Quality Detection Module
 *
 * Detects garbage/invalid fullText content before scoring. This module provides
 * fast, heuristic-based detection of common scraping failures without requiring
 * API calls.
 *
 * @module content-quality
 */

/**
 * Patterns that indicate ad blocker messages
 * @type {RegExp[]}
 */
const AD_BLOCKER_PATTERNS = [
  /\bad\s*block(er)?/i,  // \b prevents "roadblock" substring FP (17 hits pre-fix)
  /we\s+(noticed|detected|see)\s+(you('re|r)?|that\s+you('re|r)?)\s+(using|have)/i,
  /turn\s+off\s+(your\s+)?ad\s*block/i,
  /whitelist\s+(this\s+)?(site|domain|our)/i,
  /disable\s+(your\s+)?ad\s*block/i,
  /advertising\s+revenue\s+helps/i,
  /please\s+(consider\s+)?disabling\s+(your\s+)?ad/i,
  /adblock\s+(plus\s+)?button/i,
];

/**
 * Patterns that indicate paywall/subscription prompts
 * @type {RegExp[]}
 */
const PAYWALL_PATTERNS = [
  /subscribe\s+to\s+(continue|read|access)/i,
  /sign\s+in\s+to\s+(continue|read|access|view)/i,
  /log\s+in\s+to\s+(continue|read|access|view)/i,
  /members?\s+only/i,
  // Require a qualifier after "subscriber(s)" — bare "Subscriber" appears in
  // WSJ nav chrome ("Subscriber Sign-In") and is not a paywall signal on its own.
  /subscribers?\s+(only|content|exclusive|access)/i,
  /premium\s+(content|article|access)/i,
  /create\s+(a\s+)?(free\s+)?account\s+to/i,
  /already\s+a\s+(member|subscriber)/i,
  /become\s+a\s+(member|subscriber)/i,
  /free\s+trial/i,
  /unlock\s+(this\s+)?(story|article|content)/i,
  /exclusive\s+(content|access)/i,
  /paywall/i,
  /continue\s+reading\s+(your\s+)?article\s+with\s+a/i,
  /with\s+a\s+\w+\s+subscription/i,
  // NYT bot-detection / JS-loader artifact appended after partial article text.
  // Observed 2026-04-24 across 44 stuck reviews where ensemble correctly rejected
  // the file (rejectionReason=garbage_text) but classifyContentTier marked it
  // 'complete' because the trailing chrome doesn't trigger any prior pattern.
  // The full NYT chrome is "We are having trouble retrieving the article content.
  // Please enable JavaScript in your browser settings. Thank you for your patience
  // while we verify access." The first line is the most distinctive.
  // DUAL-PURPOSE: also in TRUNCATION_SIGNALS.severeAnywhere (tags 'nyt_bot_stub').
  // Here detectPaywall() uses _isPatternInTrailingJunk() to strip it via cleanText()
  // rather than marking the whole file garbage. classifyIncompleteReason() Layer A.5
  // short-circuits before Layer B's detectPaywall() call, so no routing conflict.
  /trouble\s+retrieving\s+the\s+article\s+content/i,
];

/**
 * Patterns that indicate privacy/legal pages (not review content)
 * @type {RegExp[]}
 */
const LEGAL_PAGE_PATTERNS = [
  /^privacy\s+policy/im,
  /^terms\s+(of\s+)?(use|service)/im,
  /^cookie\s+(policy|notice|consent)/im,
  /^legal\s+(notice|disclaimer)/im,
  /^copyright\s+(notice|policy)/im,
  /all\s+rights\s+reserved\.\s*$/im,
  /©\s*\d{4}.*all\s+rights\s+reserved/i,
];

/**
 * Patterns that indicate cookie consent / GDPR banners (not review content).
 * These can be very long (10K+) and contain generic words like "show" and "performance"
 * that fool theater-keyword checks.
 * @type {RegExp[]}
 */
const COOKIE_CONSENT_PATTERNS = [
  /your\s+consent\s+will\s+be\s+valid/i,
  /legitimate\s+interest/i,
  /data\s+protection\s+(regulation|authority).*\b(consent|cookie|opt[\s-]?out)\b/is,
  /consent\s+management\s+platform/i,
  /manage\s+(your\s+)?cookie\s+(preferences|settings|consent)/i,
  /we\s+use\s+cookies.*\b(consent|opt[\s-]?out|preferences)\b/is,
  /\bGDPR\b.*\b(consent|cookie|opt[\s-]?out|data\s+processing)\b/is,
];

/**
 * Patterns that indicate 404/error pages
 * @type {RegExp[]}
 */
const ERROR_PAGE_PATTERNS = [
  /page\s+not\s+found/i,
  // "404" alone matches SVG path data ("M11.404 8.74") and numeric IDs.
  // Require the error suffix or make the 404 anchored.
  /\b404\s+(?:error|not\s+found)\b/i,
  /error\s+404/i,
  // (Dropped bare /not\s+(been\s+)?found/i — matched theater prose like
  // "had not been found guilty", "has not found a way to translate".
  // /page\s+not\s+found/i above already handles standard error pages.)
  /(this\s+)?(page|article|content|url)\s+(is\s+|does\s+)?(no\s+longer|not)\s+(available|exists?)/i,
  /(this\s+)?(page|article|content|url)\s+doesn'?t\s+exist/i,
  /sorry[,.]?\s+(we\s+)?couldn'?t\s+find/i,
  /the\s+page\s+you('re|\s+are)\s+looking\s+for/i,
  // "has been removed/deleted" fires on theater-review prose ("the song has
  // been removed", "that has been deleted"). Require page-subject.
  /(?:this\s+)?(?:page|article|content|url|video|story|post)\s+has\s+been\s+(?:removed|deleted|taken\s+down)/i,
  /content\s+(is\s+)?unavailable/i,
  /page\s+(is\s+)?unavailable/i,
  /we\s+can'?t\s+find\s+(that|the)\s+(page|article)/i,
  /oops!?\s+page\s+unavailable/i,
];

// Strong, position-INDEPENDENT error-page signatures. Unlike ERROR_PAGE_PATTERNS
// (only scanned in the first 300 chars to avoid prose FPs like "has been
// removed"), these phrases are unambiguous web error-page chrome that never
// appears in real review prose, so they're safe to scan over the WHOLE body.
// Origin: Variety/AndyGram 404 pages scraped as reviews led with a long mega-menu
// chrome prefix ("Plus Icon Film… Mega Menu… Read Next:…"), pushing the
// "404 Page Not Found" / "the page you were looking for cannot be found" marker
// PAST the 300-char window, so detectErrorPage missed them and they reached
// scoring. Verified FP-safe across the corpus: 0 matches on legit scored reviews
// (2026-06-01 ship-check follow-up). See feedback_test_yml_data_gates_flap...
const STRONG_ERROR_PAGE_PATTERNS = [
  /\bpage\s+not\s+found\b/i,
  /\b404\s+(?:error|not\s+found)\b/i,
  /\berror\s+404\b/i,
  /the\s+page\s+you('re|\s+are)\s+looking\s+for/i,
];

/**
 * Scan the entire body for unambiguous error-page chrome (position-independent).
 * @param {string} text
 * @returns {{ detected: boolean, match: string|null }}
 */
function detectStrongErrorPageAnywhere(text) {
  const t = (typeof text === 'string') ? text : '';
  for (const pattern of STRONG_ERROR_PAGE_PATTERNS) {
    const m = t.match(pattern);
    if (m) return { detected: true, match: m[0] };
  }
  return { detected: false, match: null };
}

// Unambiguous full-page chrome (cookie-consent banners, dedicated legal/privacy
// pages, hard paywall walls) whose distinctive marker can be pushed PAST the
// first-500-char windows used by detectCookieConsent (line ~271) and the legal
// no-review branch (line ~845) by a long nav-chrome prefix — the exact failure
// mode the 404 STRONG_ERROR_PAGE_PATTERNS fixed for error pages.
//
// CRITICAL DIFFERENCE from STRONG_ERROR_PAGE_PATTERNS: "page not found" never
// appears in a real review's footer, so it's safe to scan position-independently
// over ANY text. These phrases DO appear as trailing footer/account chrome on
// hundreds of genuine scraped reviews (WSJ "Continue reading… with a subscription",
// HollywoodReporter "Terms of Use | Privacy Policy", TimeOut "Thanks for
// subscribing!", The Stage GDPR footer). So detectStrongChromeDumpAnywhere is
// ONLY consulted for files that LACK substantial review content (no review prose
// to protect) AND only when the marker is NOT in trailing junk — i.e. a genuine
// chrome-dump page, not a real review with a footer. Verified against the full
// corpus (2026-06-05): 0 currently-scored real reviews newly flagged. See
// memory/feedback_content_quality_regex_fps.md and the 404 origin note above.
const STRONG_CHROME_DUMP_PATTERNS = [
  // Cookie-consent / GDPR full sentences — never occur in review prose.
  /your\s+consent\s+will\s+be\s+valid/i,
  /consent\s+management\s+platform/i,
  /manage\s+(your\s+)?cookie\s+(preferences|settings|consent)/i,
  // Dedicated legal/privacy page titles at line start.
  /^cookie\s+(policy|notice|consent)\b/im,
  /^legal\s+(notice|disclaimer)\b/im,
  /^copyright\s+(notice|policy)\b/im,
  // Hard paywall walls — full call-to-action sentences (not bare "members only").
  /subscribe\s+to\s+(continue|read|access)\b/i,
  /sign\s+in\s+to\s+(continue|read|access|view)\b/i,
  /log\s+in\s+to\s+(continue|read|access|view)\b/i,
];

/**
 * Scan the whole body for unambiguous chrome-dump markers (cookie/legal/paywall
 * full-page chrome). Position-independent, but intended ONLY for callers that
 * have already established the text lacks substantial review content — see
 * STRONG_CHROME_DUMP_PATTERNS for why this must not run on real reviews.
 * @param {string} text
 * @returns {{ detected: boolean, match: string|null }}
 */
function detectStrongChromeDumpAnywhere(text) {
  const t = (typeof text === 'string') ? text : '';
  for (const pattern of STRONG_CHROME_DUMP_PATTERNS) {
    const m = t.match(pattern);
    if (m) return { detected: true, match: m[0] };
  }
  return { detected: false, match: null };
}

/**
 * Patterns that indicate newsletter/subscription forms (not review content)
 * @type {RegExp[]}
 */
const NEWSLETTER_PATTERNS = [
  /thanks?\s+for\s+subscribing/i,
  /enter\s+your\s+email/i,
  /sign\s+up\s+for\s+(our\s+)?newsletter/i,
  /subscribe\s+to\s+(our\s+)?newsletter/i,
  /get\s+(the\s+)?latest\s+(news|updates)/i,
  /newsletter\s+sign[-\s]?up/i,
  /join\s+(our\s+)?(mailing\s+)?list/i,
  /email\s+address\s+required/i,
];

/**
 * Patterns that indicate navigation junk (menus, footers, sidebars)
 * @type {RegExp[]}
 */
const NAVIGATION_PATTERNS = [
  /^(home|about|contact|faq|help|support|careers|advertise)\s*$/im,
  /skip\s+to\s+(main\s+)?content/i,
  // Word boundaries prevent matching "themenu", and requiring a nav-specific qualifier
  // for "menu" / "nav" kills legit dialogue like "drop-down menu for…".
  /\b(footer|header|sidebar|navigation|main\s+menu|site\s+menu|mobile\s+menu|hamburger\s+menu|top\s+nav|bottom\s+nav)\b/i,
  /search\s+(this\s+)?(site|website)/i,
  /related\s+(articles?|stories|posts)/i,
  /popular\s+(articles?|stories|posts)/i,
  /latest\s+(articles?|stories|news)/i,
  /trending\s+(now|stories|articles)/i,
  /read\s+more\s*[>→]/i,
  /see\s+all\s+(articles?|stories|reviews)/i,
  /^\s*(prev(ious)?|next)\s*(article|story|post)?\s*$/im,
];

/**
 * Patterns for detecting wrong article (non-theater content)
 * These indicate the content is about something other than theater
 * @type {RegExp[]}
 */
// Each pattern was audited against 2,832 real reviews for bare-keyword false positives.
// Metaphorical usage ("recipe for disaster", "cooking up a hit") and topical overlap
// (Lehman Trilogy discusses the stock market) were killing inclusion. See
// memory/feedback_content_quality_regex_fps.md for the audit and rationale.
const WRONG_ARTICLE_PATTERNS = [
  /^insidious/i,  // doc start only — /m flag would match any line
  /(?:^|\n)\s*(?:the\s+)?horror\s+(?:film|movie)\s+[A-Z]/,  // line start + Title-Case noun
  /box\s+office\s+report/i,  // "numbers/results" fire on legit theater-commerce talk
  /\bcook(?:ing)?\s+(?:instructions|time|method|class|book|school)\b|\bingredient\s+list\b|\brecipe\s+(?:card|book|box|serves)\b/i,
  /sports?\s+(news|scores|results)/i,
  /weather\s+(?:forecast|report)\s+(?:for|in|across|today|tonight|tomorrow|this\s+weekend)/i,
  /stock\s+(?:market\s+(?:close|open|index|session)|prices?\s+(?:rose|fell|surged|plunged)|trading\s+(?:session|volume|day|hours))/i,
  /^breaking\s+news/im,
  // "election results/coverage" fires on theater metaphors — reviews of
  // political satires ("diversion from the onslaught of election coverage").
  // Require line-start or a concrete-news qualifier.
  /(?:^|\n)\s*election\s+(?:results|coverage)|election\s+(?:results|coverage)\s+(?:show|showed|indicate|suggest|from|for\s+the)/i,
];

/**
 * Theater-related keywords that indicate valid review content
 * @type {string[]}
 */
const THEATER_KEYWORDS = [
  'broadway', 'theater', 'theatre', 'musical', 'stage', 'performance',
  'actor', 'actress', 'cast', 'director', 'choreographer', 'playwright',
  'curtain', 'audience', 'applause', 'intermission', 'act', 'scene',
  'costume', 'lighting', 'set design', 'orchestra', 'score', 'libretto',
  'tony', 'revival', 'premiere', 'opening night', 'standing ovation',
  'encore', 'production', 'staging', 'direction', 'book', 'lyrics',
  'ensemble', 'understudy', 'matinee', 'evening show', 'off-broadway',
  'west end', 'playbill', 'shubert', 'nederlander', 'lyceum', 'booth',
];

/**
 * Check if text contains ad blocker message
 * @param {string} text - Text to check
 * @returns {{ detected: boolean, match: string | null }}
 */
function detectAdBlocker(text) {
  for (const pattern of AD_BLOCKER_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      return { detected: true, match: match[0] };
    }
  }
  return { detected: false, match: null };
}

/**
 * Check if text contains paywall/subscription prompts
 * @param {string} text - Text to check
 * @returns {{ detected: boolean, match: string | null }}
 */
function detectPaywall(text) {
  for (const pattern of PAYWALL_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      return { detected: true, match: match[0] };
    }
  }
  return { detected: false, match: null };
}

/**
 * Check if text is a privacy/legal page
 * @param {string} text - Text to check
 * @returns {{ detected: boolean, match: string | null }}
 */
function detectLegalPage(text) {
  for (const pattern of LEGAL_PAGE_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      return { detected: true, match: match[0] };
    }
  }
  return { detected: false, match: null };
}

/**
 * Check if text is a cookie consent / GDPR banner
 * @param {string} text - Text to check
 * @returns {{ detected: boolean, match: string | null }}
 */
function detectCookieConsent(text) {
  // Check the first 500 chars — consent banners are always at the front
  const front = text.substring(0, 500);
  for (const pattern of COOKIE_CONSENT_PATTERNS) {
    const match = front.match(pattern);
    if (match) {
      return { detected: true, match: match[0] };
    }
  }
  return { detected: false, match: null };
}

/**
 * Check if text is a 404/error page
 * @param {string} text - Text to check
 * @returns {{ detected: boolean, match: string | null }}
 */
function detectErrorPage(text) {
  for (const pattern of ERROR_PAGE_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      return { detected: true, match: match[0] };
    }
  }
  return { detected: false, match: null };
}

/**
 * Check if text is newsletter/subscription form content
 * @param {string} text - Text to check
 * @returns {{ detected: boolean, match: string | null }}
 */
function detectNewsletter(text) {
  for (const pattern of NEWSLETTER_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      return { detected: true, match: match[0] };
    }
  }
  return { detected: false, match: null };
}

/**
 * Check if text is URL-only content (failed scrape that just returned URL)
 * @param {string} text - Text to check
 * @returns {{ detected: boolean, reason: string | null }}
 */
function detectUrlOnly(text) {
  const trimmed = text.trim();

  // Check if starts with http and is very short
  if (/^https?:\/\//i.test(trimmed) && trimmed.length < 1000) {
    // Count how much is actual URL vs content
    const urlMatch = trimmed.match(/^https?:\/\/[^\s]+/i);
    if (urlMatch && urlMatch[0].length > trimmed.length * 0.5) {
      return { detected: true, reason: 'Content is mostly URL' };
    }
  }

  // Check for just a bare URL
  if (/^https?:\/\/[^\s]+\s*$/i.test(trimmed)) {
    return { detected: true, reason: 'Content is only a URL' };
  }

  return { detected: false, reason: null };
}

/**
 * Check if text is navigation junk (menus, footers, etc.)
 * @param {string} text - Text to check
 * @returns {{ detected: boolean, matches: string[] }}
 */
function detectNavigationJunk(text) {
  const matches = [];

  for (const pattern of NAVIGATION_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      matches.push(match[0]);
    }
  }

  // Navigation junk typically has many short lines with menu items
  const lines = text.split('\n').filter(l => l.trim().length > 0);
  const shortLines = lines.filter(l => l.trim().length < 30);
  const shortLineRatio = lines.length > 0 ? shortLines.length / lines.length : 0;

  // If more than 70% of lines are very short and we have navigation matches
  if (shortLineRatio > 0.7 && matches.length >= 2) {
    return { detected: true, matches };
  }

  // If we have 5+ navigation patterns, likely junk
  if (matches.length >= 5) {
    return { detected: true, matches };
  }

  return { detected: false, matches };
}

/**
 * Check if text appears to be wrong article (non-theater content)
 * @param {string} text - Text to check
 * @param {string} [showTitle] - Optional show title for context
 * @returns {{ detected: boolean, reason: string | null }}
 */
function detectWrongArticle(text, showTitle) {
  const lower = text.toLowerCase();

  // Check for explicit wrong article patterns
  for (const pattern of WRONG_ARTICLE_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      return { detected: true, reason: `Contains non-theater content: "${match[0]}"` };
    }
  }

  // For short texts (<2000 chars), check if it lacks theater keywords
  if (text.length < 2000) {
    const hasTheaterContent = THEATER_KEYWORDS.some(kw => lower.includes(kw));

    if (!hasTheaterContent) {
      // Also check if show title is mentioned
      const showMentioned = showTitle && lower.includes(showTitle.toLowerCase());

      if (!showMentioned) {
        return { detected: true, reason: 'No theater-related keywords in short text' };
      }
    }
  }

  return { detected: false, reason: null };
}

/**
 * Current and recent Broadway shows for multi-show detection
 * Dynamically loaded from data/shows.json with hardcoded fallback
 * @type {string[]}
 */
let _cachedBroadwayShows = null;

function loadBroadwayShows() {
  if (_cachedBroadwayShows) return _cachedBroadwayShows;

  // Try loading from shows.json
  try {
    const fs = require('fs');
    const showsPath = require('path').join(__dirname, '../../data/shows.json');
    const raw = JSON.parse(fs.readFileSync(showsPath, 'utf-8'));
    const shows = raw.shows || raw;
    const titles = shows
      .map(s => s.title ? s.title.toLowerCase() : null)
      .filter(t => t && t.length > 3);

    if (titles.length > 0) {
      _cachedBroadwayShows = titles;
      return _cachedBroadwayShows;
    }
  } catch {
    // Fall through to hardcoded
  }

  // Hardcoded fallback
  _cachedBroadwayShows = [
    'purlie', 'ghosts', 'maybe happy ending', 'death becomes her',
    'stereophonic', 'cabaret', 'sunset boulevard', 'the outsiders',
    'hamilton', 'wicked', 'the lion king', 'chicago', 'phantom',
    'hadestown', 'moulin rouge', 'back to the future', 'merrily we roll along',
    'sweeney todd', 'the notebook', 'the great gatsby', 'water for elephants',
    'hell\'s kitchen', 'the who\'s tommy', 'suffs', 'the wiz', 'gypsy',
    'oh mary', 'appropriate', 'prayer for the french republic', 'mother play',
    'enemy of the people', 'mary jane', 'our town', 'mcneal', 'romeo juliet',
    'yellowjackets', 'queen versailles', 'once upon a mattress', 'left on tenth',
    'into the woods', 'funny girl', 'six', 'beetlejuice', 'aladdin',
    'dear evan hansen', 'come from away', 'the music man', 'company',
    'a beautiful noise', 'some like it hot', 'kimberly akimbo', 'parade',
    'shucked', 'new york new york', 'camelot', 'lempicka', 'the notebook',
    'days of wine and roses', 'pictures from home', 'the outsiders',
  ];
  return _cachedBroadwayShows;
}

// Backward-compatible getter
const CURRENT_BROADWAY_SHOWS = new Proxy([], {
  get(target, prop) {
    const shows = loadBroadwayShows();
    if (prop === 'filter') return shows.filter.bind(shows);
    if (prop === 'some') return shows.some.bind(shows);
    if (prop === 'length') return shows.length;
    if (prop === 'includes') return shows.includes.bind(shows);
    if (prop === Symbol.iterator) return shows[Symbol.iterator].bind(shows);
    if (typeof prop === 'string' && !isNaN(Number(prop))) return shows[Number(prop)];
    return Reflect.get(shows, prop);
  }
});

/**
 * Patterns that indicate article boundaries (multiple articles concatenated)
 * @type {RegExp[]}
 */
const ARTICLE_BOUNDARY_PATTERNS = [
  /now playing at the [A-Z][a-z]+ Theatre/gi,
  /currently running at the [A-Z][a-z]+ Theatre/gi,
  /playing at the [A-Z][a-z]+ Theatre/gi,
  /(?:playing|running|opens?|opened|performs?|performing|staged|is) at the (Belasco|St\. James|Winter Garden|Booth|Lyceum|Shubert|Imperial|Majestic|Broadhurst|Barrymore|Palace|Lunt-Fontanne|Gershwin|Marquis|Nederlander|Neil Simon|Rodgers|Schoenfeld|Brooks Atkinson|Circle in the Square|Helen Hayes|Jacobs|Eugene O'Neill|Longacre|Ambassador|Cort|Gerald Schoenfeld|Stephen Sondheim|Vivian Beaumont|August Wilson|Music Box|Lyric|Al Hirschfeld|American Airlines|Gielgud|Savoy|Old Vic|Young Vic|Donmar|Wyndham|Noël Coward|Noel Coward|Harold Pinter|Gillian Lynne|Phoenix|Apollo|Criterion|Dominion|Garrick|Piccadilly|Playhouse|Vaudeville|Duke of York|Duchess|Fortune|Globe|Shakespeare's Globe|Barbican|National Theatre|Olivier|Lyttelton|Dorfman|Almeida|Menier Chocolate Factory)/gi,
  /The (?:charming|brilliant|stunning|captivating|delightful|exciting|thrilling) new (?:musical|play|revival)/gi,
  /The most recent revival of/gi,
  /Director [A-Z][a-z]+ [A-Z][a-z]+…$/gm,  // EW article teasers end with director name + ellipsis
];

/**
 * Validate that text mentions the expected show
 * More robust than the basic check in assessTextQuality
 *
 * @param {string} text - Review text
 * @param {string} showTitle - Expected show title (human readable)
 * @param {string} showId - Show ID (e.g., "back-to-the-future-2023")
 * @returns {{ valid: boolean, confidence: 'high' | 'medium' | 'low', reason: string }}
 */
function validateShowMentioned(text, showTitle, showId) {
  if (!text || text.length < 100) {
    return { valid: false, confidence: 'high', reason: 'Text too short to validate' };
  }

  const lower = text.toLowerCase();

  // Check 1: Exact show title match
  if (showTitle && showTitle.length > 3) {
    const titleLower = showTitle.toLowerCase();
    if (lower.includes(titleLower)) {
      return { valid: true, confidence: 'high', reason: 'Exact show title found' };
    }

    // Check title without "The" prefix
    const withoutThe = titleLower.replace(/^the\s+/, '');
    if (withoutThe.length > 3 && lower.includes(withoutThe)) {
      return { valid: true, confidence: 'high', reason: 'Show title (without "The") found' };
    }
  }

  // Check 2: Show ID words (e.g., "back-to-the-future-2023" -> ["back", "future"])
  if (showId) {
    // Remove year suffix and split
    const idBase = showId.replace(/-\d{4}$/, '');
    const idWords = idBase.split('-').filter(w => w.length > 3 && !['the', 'and', 'for'].includes(w));

    if (idWords.length >= 2) {
      const matchCount = idWords.filter(w => lower.includes(w)).length;
      if (matchCount >= 2 || (matchCount === idWords.length)) {
        return { valid: true, confidence: 'medium', reason: `${matchCount}/${idWords.length} show ID words found` };
      }
    } else if (idWords.length === 1 && idWords[0].length > 4) {
      // Single significant word (e.g., "cabaret", "hamilton")
      if (lower.includes(idWords[0])) {
        return { valid: true, confidence: 'medium', reason: 'Show name word found' };
      }
    }
  }

  // Check 3: For very long reviews, relax the requirement slightly
  if (text.length > 3000) {
    // Long reviews might use pronouns or "the show" instead of title
    const hasTheaterContext = THEATER_KEYWORDS.filter(kw => lower.includes(kw)).length >= 5;
    if (hasTheaterContext) {
      return { valid: true, confidence: 'low', reason: 'Long review with theater context (title not found)' };
    }
  }

  return { valid: false, confidence: 'high', reason: `Show "${showTitle || showId}" not mentioned in text` };
}

/**
 * Common-word show titles that appear naturally in theater criticism.
 * These match frequently in review text without indicating wrong-page scraping.
 * Mirrors the curated set in excerpt-validation.js.
 */
const COMMON_WORD_SHOW_TITLES = new Set([
  // Common English words
  'company', 'doubt', 'network', 'proof', 'sweat', 'closer', 'home', 'nine',
  'cats', 'rent', 'once', 'hair', 'big', 'grease', 'chicago', 'fame',
  'oliver', 'pippin', 'annie', 'carousel', 'contact', 'curtains', 'follies',
  'gypsy', 'tommy', 'ragtime', 'purlie', 'ruined', 'eclipse', 'wings', 'bent',
  'betrayal', 'hero', 'power', 'appropriate', 'beautiful', 'holiday', 'parade',
  'passion', 'spring', 'summer', 'stomp', 'sunset', 'cabaret', 'harvey',
  'the audience', 'master class', 'the performers', 'the present', 'the price',
  'the real thing', 'all the way', 'liberation', 'slave play',
  'bug', 'juno', 'fela', 'fun', 'leap', 'loot',
  'junk', 'high', 'well', 'good', 'match', 'legend', 'broadway', 'the act',
  'the father', 'swept away', 'race', 'rose', 'dream', 'tribute',
  // Common words that cause massive false positives in multi-show detection
  'rain', 'sting', 'care', 'touch', 'soon', 'baby', 'angel', 'working',
  'november', 'brooklyn', 'mail', 'players', 'voices', 'stages', 'data',
  'purpose', 'english', 'giant', 'smash', 'tricks', 'nuts', 'fools',
  'knockout', 'metro', 'plenty', 'grind', 'pride', 'punch', 'spread',
  'shelter', 'scratch', 'smile', 'sugar', 'wanted', 'doubles', 'dude',
  'enemies', 'frozen', 'freak', 'misery', 'orphans', 'rocky', 'rumors',
  'thieves', 'trash', 'warp', 'brothers', 'bully', 'buddy',
  'ambassador', 'steaming', 'monument', 'consumed', 'anonymous',
]);

/**
 * Detect if text contains references to multiple different Broadway shows
 * This indicates a 404/index page or navigation junk, not a single review
 *
 * @param {string} text - Text to check
 * @param {string} [expectedShowId] - The show this review should be about (excluded from count)
 * @returns {{ detected: boolean, showsFound: string[], reason: string | null }}
 */
function detectMultiShowContent(text, expectedShowId) {
  if (!text || text.length < 200) {
    return { detected: false, showsFound: [], reason: null };
  }

  const lower = text.toLowerCase();

  // Extract the expected show's key words to exclude them. Lowercase so the
  // downstream substring check matches the lowercase titles from shows.json —
  // a title-case showId like 'Hamilton' would otherwise fail to filter out the
  // 'hamilton' entry and show up as an unexpected additional mention.
  const expectedWords = expectedShowId
    ? expectedShowId.toLowerCase().replace(/-\d{4}$/, '').split('-').filter(w => w.length > 3)
    : [];

  // Find which shows are mentioned, excluding common-word titles
  // Use word-boundary matching to prevent "elling" matching "compelling",
  // "sting" matching "interesting", "touch" matching "touching", etc.
  const foundShows = CURRENT_BROADWAY_SHOWS.filter(show => {
    // Skip common English words that happen to be show titles
    if (COMMON_WORD_SHOW_TITLES.has(show)) return false;

    // Skip if this is the expected show
    const showWords = show.split(/\s+/);
    const isExpectedShow = expectedWords.some(ew => showWords.some(sw => sw.includes(ew) || ew.includes(sw)));
    if (isExpectedShow) return false;

    // Use word-boundary regex instead of substring matching
    const escaped = show.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`, 'i');
    return regex.test(text);
  });

  // Scale threshold by text length — critics routinely reference other shows for comparison
  // Short text (< 1000 chars) with 3+ shows = likely junk page
  // Long reviews (5000+ chars) are substantial articles where many references are normal
  const threshold = text.length < 1000 ? 3
    : text.length < 3000 ? 5
    : text.length < 5000 ? 7
    : text.length < 8000 ? 10
    : 15;
  if (foundShows.length >= threshold) {
    return {
      detected: true,
      showsFound: foundShows,
      reason: `Multiple shows mentioned (${foundShows.length}): ${foundShows.slice(0, 5).join(', ')}${foundShows.length > 5 ? '...' : ''}`
    };
  }

  return { detected: false, showsFound: foundShows, reason: null };
}

/**
 * Detect if text has multiple articles concatenated together
 * This happens when scrapers include "related articles" or "more reviews" sections
 *
 * @param {string} text - Text to check
 * @param {string} [expectedShowId] - The show this review should be about
 * @returns {{ detected: boolean, reason: string | null, truncateAt: number | null }}
 */
function detectConcatenatedArticles(text, expectedShowId) {
  if (!text || text.length < 500) {
    return { detected: false, reason: null, truncateAt: null };
  }

  // Count article boundary patterns
  let boundaryMatches = [];
  for (const pattern of ARTICLE_BOUNDARY_PATTERNS) {
    // Reset regex lastIndex for global patterns
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      boundaryMatches.push({ index: match.index, match: match[0] });
    }
  }

  // Dedupe: a review that mentions "at the Nederlander Theatre" 4x (opening
  // paragraph, lede, press-info footer, photo credit) shouldn't register as
  // 4 boundaries — that's one article discussing one theater. True concatenation
  // has matches with DIFFERENT captured content. Count unique matches only.
  // Regression signal: TRL Schmigadoon review 2026-04-23 had 4 "at the
  // Nederlander" mentions, tripped the 3+ gate, got classified as scraper_garbage
  // and silently skipped. See memory/feedback_article_boundary_dedupe.md.
  const uniqueMatchStrings = new Set(
    boundaryMatches.map(m => m.match.toLowerCase().replace(/\s+/g, ' ').trim())
  );
  const uniqueMatchCount = uniqueMatchStrings.size;

  // If we have 3+ UNIQUE article boundary patterns, likely concatenated.
  // (Single-article review can repeat the same theater or phrase multiple
  // times; that's fine. True concatenation has different signatures.)
  if (uniqueMatchCount >= 3) {
    // Sort by position
    boundaryMatches.sort((a, b) => a.index - b.index);
    // The first boundary after position 500 is likely where concatenation starts
    const firstBoundary = boundaryMatches.find(m => m.index > 500);
    if (firstBoundary) {
      return {
        detected: true,
        reason: `Multiple article boundaries detected (${uniqueMatchCount} unique of ${boundaryMatches.length} total)`,
        truncateAt: firstBoundary.index
      };
    }
  }

  // Also check for multiple different shows combined with short article teasers
  const multiShow = detectMultiShowContent(text, expectedShowId);
  if (multiShow.detected && multiShow.showsFound.length >= 2) {
    // Find where the first "other show" is mentioned
    const lower = text.toLowerCase();
    let earliestOtherShow = text.length;
    for (const show of multiShow.showsFound) {
      const idx = lower.indexOf(show);
      if (idx > 500 && idx < earliestOtherShow) {
        earliestOtherShow = idx;
      }
    }
    if (earliestOtherShow < text.length) {
      // Look for sentence boundary before the other show mention
      const beforeOther = text.substring(0, earliestOtherShow);
      const lastPeriod = beforeOther.lastIndexOf('. ');
      const truncateAt = lastPeriod > 500 ? lastPeriod + 1 : earliestOtherShow;

      return {
        detected: true,
        reason: `Other shows detected in text: ${multiShow.showsFound.join(', ')}`,
        truncateAt
      };
    }
  }

  return { detected: false, reason: null, truncateAt: null };
}

/**
 * Patterns indicating horror/film content (common scraping mistake where
 * a movie review got attributed to a Broadway show). NOT auto-rejecting —
 * detectHorrorFilmContent requires the text to ALSO lack 3+ theater keywords.
 *
 * Full-corpus audit 2026-04-24: the bare patterns fire on 312 reviews, but
 * the keyword guard absorbs 100% — zero pass through to rejection. Kept at
 * module scope so the regex-FP audit harness can gate them.
 * @type {RegExp[]}
 */
const HORROR_FILM_PATTERNS = [
  /insidious/i,
  /horror\s*(film|movie|sequel)/i,
  /terrifying\s+sequel/i,
  /haunted\s+(family|house|lambert)/i,
  /spirit\s+world/i,
  /scary\s+movies?/i,
  /horror\s+film/i,
];

/**
 * Check if text contains indicators of a horror/film review (common scraping mistake)
 * @param {string} text - Text to check
 * @returns {{ detected: boolean, reason: string | null }}
 */
function detectHorrorFilmContent(text) {
  const lower = text.toLowerCase();

  for (const pattern of HORROR_FILM_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      // Make sure this isn't a legitimate theater review that mentions horror elements
      // Check if there are also theater keywords
      const hasTheaterKeywords = THEATER_KEYWORDS.filter(kw => lower.includes(kw)).length >= 3;
      if (!hasTheaterKeywords) {
        return { detected: true, reason: `Horror/film content detected: "${match[0]}"` };
      }
    }
  }

  return { detected: false, reason: null };
}

/**
 * Main function to check if content is garbage/invalid
 *
 * @param {string} text - The fullText content to check
 * @returns {{ isGarbage: boolean, reason: string }}
 */
function isGarbageContent(text) {
  // Null/undefined check
  if (text === null || text === undefined) {
    return { isGarbage: true, reason: 'No content (null or undefined)' };
  }

  // Empty or whitespace-only
  const trimmed = (typeof text === 'string') ? text.trim() : '';
  if (trimmed.length === 0) {
    return { isGarbage: true, reason: 'Empty content (no text)' };
  }

  // Very short content (less than 100 chars)
  if (trimmed.length < 100) {
    return { isGarbage: true, reason: `Content too short (${trimmed.length} chars)` };
  }

  // Mostly whitespace — real reviews have >30% non-whitespace characters
  const nonWhitespace = trimmed.replace(/\s/g, '').length;
  if (nonWhitespace < trimmed.length * 0.3 && nonWhitespace < 500) {
    return { isGarbage: true, reason: `Mostly whitespace (${nonWhitespace} non-ws chars out of ${trimmed.length})` };
  }

  // Position-aware check: for ad blocker, paywall, newsletter, and legal patterns,
  // only flag as garbage if the pattern appears in the FRONT of the text.
  // If the pattern is trailing junk on an otherwise valid review, cleanText() will
  // handle it — don't reject the entire review.
  const hasSubstantialReviewContent = trimmed.length >= 500 && _countTheaterKeywords(trimmed) >= 3;

  // Check for cookie consent / GDPR banner — always garbage, even with theater keywords
  // (consent text contains generic words like "show", "performance" that fool keyword checks)
  const cookieConsent = detectCookieConsent(text);
  if (cookieConsent.detected) {
    return { isGarbage: true, reason: `Cookie consent/GDPR banner: "${cookieConsent.match}"` };
  }

  // Buried chrome-dump scan. detectCookieConsent and the legal no-review branch
  // both only look at the first 500 chars; a long nav-chrome prefix can push the
  // cookie/legal/paywall marker past that window on a page that is entirely
  // chrome (no review). Mirror the 404 STRONG_ERROR scan, but gate hard on
  // (a) NO substantial review content — there's no review prose to protect — and
  // (b) the marker not being trailing junk, so a footer link/banner on a short
  // real review is never flagged. Both conditions hold only for true chrome dumps.
  if (!hasSubstantialReviewContent) {
    const strongChrome = detectStrongChromeDumpAnywhere(trimmed);
    if (strongChrome.detected && !_isPatternInTrailingJunk(trimmed, strongChrome.match)) {
      return { isGarbage: true, reason: `Chrome-dump page (buried marker): "${strongChrome.match}"` };
    }
  }

  // Check for ad blocker message
  const adBlocker = detectAdBlocker(text);
  if (adBlocker.detected) {
    if (hasSubstantialReviewContent && _isPatternInTrailingJunk(text, adBlocker.match)) {
      // Ad blocker message is trailing junk — let cleanText() strip it
    } else {
      return { isGarbage: true, reason: `Ad blocker message: "${adBlocker.match}"` };
    }
  }

  // Check for paywall
  const paywall = detectPaywall(text);
  if (paywall.detected) {
    if (hasSubstantialReviewContent && _isPatternInTrailingJunk(text, paywall.match)) {
      // Paywall prompt is trailing junk — let cleanText() strip it
    } else {
      return { isGarbage: true, reason: `Paywall/subscription prompt: "${paywall.match}"` };
    }
  }

  // Check for 404/error page
  // For longer texts (>500 chars), only check the first 300 meaningful chars — real reviews
  // may contain phrases like "has been removed" in legitimate theatrical context.
  // Collapse whitespace first so leading blank lines don't consume the check window.
  const collapsedForErrorCheck = trimmed.replace(/\s+/g, ' ');
  const errorCheckText = collapsedForErrorCheck.length > 500
    ? collapsedForErrorCheck.substring(0, 300)
    : collapsedForErrorCheck;
  const errorPage = detectErrorPage(errorCheckText);
  if (errorPage.detected) {
    return { isGarbage: true, reason: `Error/404 page: "${errorPage.match}"` };
  }

  // Strong error-page signatures scanned over the WHOLE body (not just the first
  // 300 chars). Catches 404 pages whose error marker is buried after a long
  // nav-chrome prefix (Variety mega-menu, etc.) — the 300-char window above
  // misses those. Only the unambiguous phrases (FP-safe corpus-wide).
  const strongError = detectStrongErrorPageAnywhere(collapsedForErrorCheck);
  if (strongError.detected) {
    return { isGarbage: true, reason: `Error/404 page (body): "${strongError.match}"` };
  }

  // Check for legal/privacy page
  // For longer texts, only flag if pattern is in the front — real reviews
  // often have "All Rights Reserved" or copyright as footer boilerplate.
  const legalPage = detectLegalPage(text);
  if (legalPage.detected) {
    if (hasSubstantialReviewContent && _isPatternInTrailingJunk(text, legalPage.match)) {
      // Legal/copyright is trailing junk — let cleanText() strip it
    } else if (trimmed.length > 1000) {
      // For long texts without review content, only check the first 500 chars
      const legalFrontCheck = detectLegalPage(trimmed.substring(0, 500));
      if (legalFrontCheck.detected) {
        return { isGarbage: true, reason: `Legal/privacy page: "${legalFrontCheck.match}"` };
      }
    } else {
      return { isGarbage: true, reason: `Legal/privacy page: "${legalPage.match}"` };
    }
  }

  // Check for newsletter form
  const newsletter = detectNewsletter(text);
  if (newsletter.detected) {
    if (hasSubstantialReviewContent && _isPatternInTrailingJunk(text, newsletter.match)) {
      // Newsletter form is trailing junk — let cleanText() strip it
    } else if (hasSubstantialReviewContent && _isPatternInLeadingJunk(text, newsletter.match)) {
      // Newsletter form is leading junk (e.g., TimeOut "Thanks for subscribing!" header)
    } else {
      return { isGarbage: true, reason: `Newsletter form: "${newsletter.match}"` };
    }
  }

  // Check for URL-only content
  const urlOnly = detectUrlOnly(text);
  if (urlOnly.detected) {
    return { isGarbage: true, reason: urlOnly.reason };
  }

  // Check for navigation junk
  const navJunk = detectNavigationJunk(text);
  if (navJunk.detected) {
    return { isGarbage: true, reason: `Navigation junk (${navJunk.matches.length} patterns matched)` };
  }

  // Check for horror/film content (common scraping error)
  const horrorContent = detectHorrorFilmContent(text);
  if (horrorContent.detected) {
    return { isGarbage: true, reason: horrorContent.reason };
  }

  // Content passes all garbage checks
  return { isGarbage: false, reason: 'Content appears valid' };
}

/**
 * Count theater keywords in text (fast heuristic for review content detection)
 * @param {string} text
 * @returns {number}
 */
function _countTheaterKeywords(text) {
  const lower = text.toLowerCase();
  return THEATER_KEYWORDS.filter(kw => lower.includes(kw)).length;
}

/**
 * Check if a matched pattern appears in the trailing portion (last 40%) of text.
 * Used to distinguish "page IS garbage" from "review WITH trailing junk".
 * @param {string} text - Full text
 * @param {string} matchStr - The matched pattern string
 * @returns {boolean}
 */
function _isPatternInTrailingJunk(text, matchStr) {
  if (!matchStr) return false;
  const idx = text.lastIndexOf(matchStr);
  if (idx < 0) {
    // Pattern was found via regex — search case-insensitively
    const lowerIdx = text.toLowerCase().lastIndexOf(matchStr.toLowerCase());
    if (lowerIdx < 0) return false;
    return lowerIdx > text.length * 0.6;
  }
  return idx > text.length * 0.6;
}

/**
 * Check if a matched pattern appears in the leading portion (first 20%) of text.
 * Used to detect leading newsletter headers on otherwise valid reviews.
 * @param {string} text - Full text
 * @param {string} matchStr - The matched pattern string
 * @returns {boolean}
 */
function _isPatternInLeadingJunk(text, matchStr) {
  if (!matchStr) return false;
  const idx = text.indexOf(matchStr);
  if (idx < 0) {
    const lowerIdx = text.toLowerCase().indexOf(matchStr.toLowerCase());
    if (lowerIdx < 0) return false;
    return lowerIdx < text.length * 0.2;
  }
  return idx < text.length * 0.2;
}

/**
 * Check if text has theater-related review content
 *
 * @param {string} text - Text to check
 * @returns {{ hasReviewContent: boolean, keywordsFound: string[], confidence: 'high' | 'medium' | 'low' }}
 */
function hasReviewContent(text) {
  if (!text || text.trim().length === 0) {
    return { hasReviewContent: false, keywordsFound: [], confidence: 'high' };
  }

  const lower = text.toLowerCase();
  const found = THEATER_KEYWORDS.filter(kw => lower.includes(kw));

  // Determine confidence based on keyword count
  let confidence;
  if (found.length >= 5) {
    confidence = 'high';
  } else if (found.length >= 2) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }

  return {
    hasReviewContent: found.length > 0,
    keywordsFound: found,
    confidence
  };
}

/**
 * Comprehensive text quality assessment
 *
 * @param {string} text - The fullText content to assess
 * @param {string} [showId] - Optional show ID for additional checks (e.g., "back-to-the-future-2023")
 * @param {string} [showTitle] - Optional show title for additional checks (human readable)
 * @returns {{ quality: 'valid' | 'garbage' | 'suspicious', confidence: 'high' | 'medium' | 'low', issues: string[] }}
 */
function assessTextQuality(text, showId, showTitle) {
  const issues = [];

  // First check if it's garbage
  const garbageCheck = isGarbageContent(text);
  if (garbageCheck.isGarbage) {
    return {
      quality: 'garbage',
      confidence: 'high',
      issues: [garbageCheck.reason]
    };
  }

  // Check for multi-show content (indicates 404/index page)
  // But first: if the expected show IS mentioned, multi-show refs are likely
  // legitimate critic comparisons, not junk. Only flag if show is NOT mentioned.
  const showToCheck = showTitle || showId;
  const showMentionedEarly = showToCheck && text.length >= 200
    ? validateShowMentioned(text, showTitle, showId)
    : { valid: true };
  const multiShowCheck = detectMultiShowContent(text, showId);
  if (multiShowCheck.detected && !showMentionedEarly.valid) {
    return {
      quality: 'garbage',
      confidence: 'high',
      issues: [multiShowCheck.reason]
    };
  }

  // Check for concatenated articles (other reviews appended)
  // Only check when the expected show isn't mentioned — if it IS mentioned,
  // other show references are likely legitimate critic comparisons, not concatenation.
  // The article-boundary sub-check (3+ "theater presents" patterns) always runs;
  // the multi-show sub-check is what produces false positives on comparative reviews.
  const concatenatedCheck = detectConcatenatedArticles(text, showId);
  if (concatenatedCheck.detected) {
    const isBoundaryDetection = concatenatedCheck.reason && concatenatedCheck.reason.includes('article boundaries');
    if (isBoundaryDetection || !showMentionedEarly.valid) {
      return {
        quality: 'garbage',
        confidence: 'high',
        issues: [concatenatedCheck.reason],
        truncateAt: concatenatedCheck.truncateAt
      };
    }
  }

  // Check for review content
  const reviewCheck = hasReviewContent(text);
  if (!reviewCheck.hasReviewContent) {
    issues.push('No theater-related keywords found');
  }

  // Use the enhanced show title validation
  const showToValidate = showTitle || showId;
  if (showToValidate && text.length >= 200) {
    const showValidation = validateShowMentioned(text, showTitle, showId);
    if (!showValidation.valid) {
      // For high confidence invalid, it's a serious issue
      if (showValidation.confidence === 'high') {
        issues.push(`Show not mentioned: ${showValidation.reason}`);
      } else {
        // Low/medium confidence - add as warning but don't fail immediately
        issues.push(`Warning: ${showValidation.reason}`);
      }
    }
  }

  // Check for wrong article
  const wrongArticle = detectWrongArticle(text, showTitle || showId);
  if (wrongArticle.detected) {
    issues.push(wrongArticle.reason);
  }

  // Check text length
  if (text.length < 300) {
    issues.push(`Very short content (${text.length} chars)`);
  } else if (text.length < 500) {
    issues.push(`Short content (${text.length} chars)`);
  }

  // Determine overall quality
  let quality;
  let confidence;

  // Count serious issues (not warnings)
  const seriousIssues = issues.filter(i => !i.startsWith('Warning:'));
  const warningIssues = issues.filter(i => i.startsWith('Warning:'));

  if (seriousIssues.length === 0 && warningIssues.length === 0) {
    quality = 'valid';
    confidence = 'high';
  } else if (seriousIssues.length === 0 && warningIssues.length > 0) {
    quality = 'valid';
    confidence = 'medium';
  } else if (seriousIssues.length === 1 && !seriousIssues[0].includes('No theater')) {
    quality = 'valid';
    confidence = 'medium';
  } else if (seriousIssues.length <= 2) {
    quality = 'suspicious';
    confidence = 'medium';
  } else {
    quality = 'garbage';
    confidence = 'high';
  }

  return { quality, confidence, issues };
}

/**
 * =============================================================================
 * CONTENT TIER CLASSIFICATION (5-Tier Taxonomy)
 * =============================================================================
 *
 * Classifies review content into mutually exclusive quality tiers:
 * - T1: complete  - Full review successfully scraped
 * - T2: truncated - Partial text due to paywall/bot detection
 * - T3: excerpt   - Only aggregator quotes available
 * - T4: stub      - Has metadata but no text content
 * - T5: invalid   - Garbage/wrong show/corrupted
 */

/**
 * Truncation signal patterns
 */
const TRUNCATION_SIGNALS = {
  // Severe signals - definitely truncated
  severe: [
    /subscribe\s+to\s+(continue|read|access)/i,
    /sign\s+in\s+to\s+(continue|read|access)/i,
    /log\s+in\s+to\s+(continue|read)/i,
    /members?\s+only/i,
    /read\s+more\s*\.{0,3}$/i,
    /continue\s+reading/i,
    /click\s+here\s+to\s+read/i,
    /full\s+(article|story)\s+(available|requires)/i,
  ],
  // Severe signals that must scan the FULL text (not just first 70%).
  // These are position-independent: they never appear in real review prose,
  // so there is no risk of false positives from footer chrome.
  // The 70% window on `severe` was added to prevent "Read More" navigation
  // links from falsely flagging paywalls; that concern does not apply here.
  severeAnywhere: [
    // NYT bot-detection / JS-loader artifact that appears AFTER partial article text.
    // The scraper captured only the visible (pre-bot-wall) portion of the review.
    // Appears at 90-95% of the file — always outside the 70% severe scan window.
    // Observed across 185 files (2026-06-05 probe). See PAYWALL_PATTERNS line ~55
    // for the corresponding detectPaywall() entry and the audit-regex-patterns.js
    // PAYWALL_PATTERNS::15 allow-listing entry.
    /trouble\s+retrieving\s+the\s+article\s+content/i,
  ],
  // Moderate signals - likely truncated
  moderate: [
    /\.{3}\s*$/,  // Ends with ellipsis
    /…\s*$/,      // Unicode ellipsis
    /\[\s*\.\.\.\s*\]/,  // [...]
  ],
  // Footer junk - text continues past review ending
  footer: [
    /privacy\s+policy/i,
    /terms\s+of\s+(use|service)/i,
    /^\s*©\s*(?:19|20)\d{2}/m,  // © at start of line only (not inline photo credits)
    /all\s+rights\s+reserved/i,
    /cookie\s+(policy|settings|preferences)/i,
    /advertise\s+with\s+us/i,
    /\bsubscribe\s+to\s+(?:our|the)\s+newsletter/i,
    /\bsign\s+up\s+for\s+(?:our|the)\b/i,
    /\brelated\s+(?:stories|articles|posts)\b/i,
    /\brecommended\s+(?:videos|stories|for\s+you)\b/i,
    /\bmore\s+from\s+(?:this|the)\b/i,
    /\bpowered\s+by\b/i,
    /\bshare\s+(?:this|on\s+(?:facebook|twitter|x))\b/i,
    /\bfollow\s+us\s+on\b/i,
    /\bleave\s+a\s+(?:comment|reply)\b/i,
    /\bcomments?\s*(?:\(\d+\))?\s*$/im,
    // These overlap with severe signals but must also be here so
    // stripFooterContent removes them before severe detection runs.
    // Only match at end of line to avoid mid-sentence false positives.
    /\bread\s+more\s*\.{0,3}\s*$/im,
    /\bcontinue\s+reading\s*$/im,
    /\bclick\s+here\s+to\s+read\b/i,
    /\byou\s+may\s+also\s+like\b/i,
  ]
};

/**
 * Strip trailing footer content from scraped review text.
 * Websites often append navigation, legal notices, and promotional content
 * after the review. This function finds the earliest footer marker in the
 * back portion of the text and returns everything before it.
 *
 * Only used for classification — does NOT modify stored fullText.
 *
 * @param {string} text - Raw scraped text
 * @returns {string} Text with trailing footer removed
 */
function stripFooterContent(text) {
  if (!text || text.length < 400) return text;

  // Minimum chars of review content before we allow a cut.
  // Prevents stripping a short review that happens to mention "privacy policy".
  const MIN_REVIEW_CHARS = 600;

  let cutPoint = text.length;
  for (const pattern of TRUNCATION_SIGNALS.footer) {
    // Search the back 40% of the text for footer markers
    const searchStart = Math.max(0, Math.floor(text.length * 0.6));
    const searchRegion = text.substring(searchStart);
    const match = searchRegion.match(pattern);
    if (match) {
      const absoluteIndex = searchStart + match.index;
      // Only cut if enough review content precedes the marker
      if (absoluteIndex >= MIN_REVIEW_CHARS) {
        cutPoint = Math.min(cutPoint, absoluteIndex);
      }
    }
  }

  if (cutPoint < text.length) {
    return text.substring(0, cutPoint).trim();
  }
  return text;
}

/**
 * Detect truncation signals in text
 * @param {string} text - Text to analyze
 * @returns {{ signals: string[], severeCount: number, moderateCount: number, likelyTruncated: boolean }}
 */
function detectTruncationSignals(text) {
  if (!text) return { signals: [], severeCount: 0, moderateCount: 0, likelyTruncated: false };

  const signals = [];
  let severeCount = 0;
  let moderateCount = 0;

  // Check severe signals.
  // For long texts (1500+ chars), only check the first 70% — severe signals
  // in the footer region (e.g., "Read More" in navigation links) are not paywalls.
  const severeRegion = text.length >= 1500
    ? text.substring(0, Math.floor(text.length * 0.7))
    : text;
  for (const pattern of TRUNCATION_SIGNALS.severe) {
    if (pattern.test(severeRegion)) {
      signals.push('paywall_or_login_prompt');
      severeCount++;
      break; // One severe is enough
    }
  }

  // Check position-independent severe signals (full text scan).
  // These patterns are unambiguous — they never appear in real review prose,
  // so the 70% region restriction does not apply.
  if (severeCount === 0) {
    for (const pattern of TRUNCATION_SIGNALS.severeAnywhere) {
      if (pattern.test(text)) {
        signals.push('nyt_bot_stub');
        severeCount++;
        break;
      }
    }
  }

  // WSJ paywall CTA — position-gated: only flag as truncated when the CTA appears
  // before 90% of the text. At ≥90% it is footer chrome on a complete review
  // (cleanText() strips it); before 90% the article was cut off at the subscription
  // wall (same bug class as nyt_bot_stub, smaller scale — 1776-2022 observed 2026-06-06).
  if (severeCount === 0) {
    const wsjCtaPat = /reading\s+your\s+article\s+with\s*a?\s+WSJ\s+(?:membership|subscription)/i;
    const wsjM = wsjCtaPat.exec(text);
    if (wsjM && wsjM.index < text.length * 0.9) {
      signals.push('wsj_paywall_cta');
      severeCount++;
    }
  }

  // Check moderate signals
  for (const pattern of TRUNCATION_SIGNALS.moderate) {
    if (pattern.test(text)) {
      signals.push('ends_with_ellipsis');
      moderateCount++;
      break;
    }
  }

  // Check for footer junk (indicates text went past review ending)
  let hasFooterJunk = false;
  const lastChunk = text.slice(-500);
  for (const pattern of TRUNCATION_SIGNALS.footer) {
    if (pattern.test(lastChunk)) {
      hasFooterJunk = true;
      signals.push('has_footer_junk');
      break;
    }
  }

  // Check if text ends with proper punctuation (includes EW-style letter grades like B+, A-)
  // When footer junk is present, don't penalize for bad ending — the review likely
  // ends with proper punctuation before the footer.
  const trimmed = text.trim();
  if (!hasFooterJunk && trimmed.length > 100 && !/[.!?"'"")\]]$/.test(trimmed) && !/[.!?]\s*[A-DF][+-]?$/.test(trimmed)) {
    signals.push('no_ending_punctuation');
    moderateCount++;
  }

  return {
    signals,
    severeCount,
    moderateCount,
    likelyTruncated: severeCount > 0 || moderateCount >= 2
  };
}

/**
 * Count words in text
 * @param {string} text
 * @returns {number}
 */
function countWords(text) {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(w => w.length > 0).length;
}

/**
 * Detect opinion/evaluative language in text.
 * Unlike hasReviewContent() which checks topic keywords (Broadway, production),
 * this checks for critical assessment language that distinguishes a review from
 * a press release, listing, or plot summary.
 *
 * @param {string} text
 * @returns {boolean} true if at least 2 opinion markers found
 */
function hasOpinionLanguage(text) {
  if (!text) return false;
  const lower = text.toLowerCase();
  // Evaluative/opinion words common in theater criticism
  const opinionMarkers = [
    /\b(brilliant|stunning|captivating|riveting|extraordinary|superb|magnificent)\b/,
    /\b(disappointing|lackluster|mediocre|uninspired|tedious|overwrought|clunky)\b/,
    /\b(succeeds|fails|struggles|excels|shines|falters|stumbles|soars|triumphs)\b/,
    /\b(unfortunately|thankfully|surprisingly|remarkably|impressively|sadly)\b/,
    /\b(best|worst|better|worse|strongest|weakest|finest|most\s+compelling)\b/,
    /\b(heartfelt|moving|powerful|gripping|dull|flat|lifeless|electrifying)\b/,
    /\b(recommended|must-see|skip|worth\s+(seeing|watching|the\s+trip))\b/,
    /\b(gives?\s+a?\s*(great|terrific|wonderful|solid|fine|nuanced|layered)\s+performance)\b/,
    /\b(direction\s+is|score\s+is|choreography\s+is|book\s+is|script\s+is)\b/,
    /\b(outshines|overshadows|steals\s+the\s+show|carries\s+the\s+show)\b/,
    // Common evaluative language in theater criticism — needed for long-biographical outlets
    /\b(hilarious|deliriously|razor-sharp|piercing|lacerating|incisive|impeccably)\b/,
    /\b(entertaining|enjoyable|engaging|charming|affecting|mesmerizing|hypnotic)\b/,
    /\b(perfectly\s+cast|well\s+cast|perfectly\s+suited|well\s+suited)\b/,
  ];
  let matches = 0;
  for (const pattern of opinionMarkers) {
    if (pattern.test(lower)) {
      matches++;
      if (matches >= 2) return true;
    }
  }
  return false;
}

/**
 * Classify a review into one of five content tiers
 *
 * @param {Object} review - Review object with fullText, excerpts, etc.
 * @returns {{
 *   contentTier: 'complete' | 'truncated' | 'excerpt' | 'stub' | 'invalid',
 *   wordCount: number,
 *   truncationSignals: string[],
 *   tierReason: string
 * }}
 */
function classifyContentTier(review) {
  // Manual override — mirrors the humanReviewScore pattern.
  // Set manualContentTier on a review source file during opening night corrections
  // to prevent rebuild from reclassifying it.
  const VALID_TIERS = new Set(['complete', 'truncated', 'excerpt', 'stub', 'invalid']);
  if (review.manualContentTier && VALID_TIERS.has(review.manualContentTier)) {
    // Exception: manualContentTier=complete is overridden when severe truncation
    // signals (e.g. nyt_bot_stub) are present. The text is objectively incomplete
    // regardless of what was manually set — the manual override was incorrect.
    if (review.manualContentTier === 'complete') {
      const sigs = detectTruncationSignals(review.fullText || '', { outletId: review.outletId, publishDate: review.publishDate });
      if (sigs.severeCount > 0) {
        return {
          contentTier: 'truncated',
          wordCount: countWords(review.fullText || ''),
          truncationSignals: sigs.signals,
          tierReason: `Downgraded from manual complete: severe signals ${sigs.signals.join(', ')}`
        };
      }
    }
    return {
      contentTier: review.manualContentTier,
      wordCount: countWords(review.fullText || ''),
      truncationSignals: [],
      tierReason: `Manual override (manualContentTier: ${review.manualContentTier})`
    };
  }

  const fullText = review.fullText || '';
  const wordCount = countWords(fullText);
  const charCount = fullText.length;

  // Check for excerpts
  const hasExcerpt = !!(review.dtliExcerpt || review.bwwExcerpt || review.showScoreExcerpt || review.nycTheatreExcerpt || review.lboRoundupExcerpt);
  const longestExcerptLen = Math.max(
    (review.dtliExcerpt || '').length,
    (review.bwwExcerpt || '').length,
    (review.showScoreExcerpt || '').length,
    (review.lboRoundupExcerpt || '').length
  );

  // T5: INVALID - Check first (garbage, wrong show, corrupted)
  // Effectively-wrong-production: wrongProduction=true is NOT invalidating when any of these
  // clear-signaling flags are set — the rebuild pipeline's later auto-clear passes will flip
  // wrongProduction to false. Without this gate, the early-pass safety-net writes contentTier='invalid'
  // to disk based on stale wrongProduction, and the (later-running) auto-clear never re-runs the
  // classifier. See Notion card 34c637c5-416f-8199 (2026-04-24 reclassify backfill).
  const effectivelyWrongProduction = review.wrongProduction
    && !review.allowEarlyDate
    && !review.allowCrossMarket
    && !review.wrongProductionManualClear
    && !review.wrongProductionCleared
    && !review.wrongProductionAutoCleared
    && review.humanReviewedWrongProduction !== false;
  const effectivelyWrongShow = review.wrongShow && !review.wrongShowManualClear;
  if (review.textStatus === 'garbage_cleared' || effectivelyWrongProduction || effectivelyWrongShow) {
    return {
      contentTier: 'invalid',
      wordCount,
      truncationSignals: [],
      tierReason: review.textStatus === 'garbage_cleared' ? 'Marked as garbage'
        : effectivelyWrongShow ? 'Wrong show'
        : 'Wrong production'
    };
  }

  // Check if fullText is garbage
  if (charCount >= 100) {
    const garbageCheck = isGarbageContent(fullText);
    if (garbageCheck.isGarbage) {
      return {
        contentTier: 'invalid',
        wordCount,
        truncationSignals: [],
        tierReason: `Garbage content: ${garbageCheck.reason}`
      };
    }
  }

  // T4: STUB - No usable text at all
  if (charCount < 100 && !hasExcerpt) {
    return {
      contentTier: 'stub',
      wordCount,
      truncationSignals: [],
      tierReason: charCount === 0 ? 'No text content' : 'Insufficient text and no excerpts'
    };
  }

  // T3: EXCERPT - Only aggregator excerpts, no meaningful fullText
  if (charCount < 100 && hasExcerpt) {
    return {
      contentTier: 'excerpt',
      wordCount,
      truncationSignals: [],
      tierReason: 'Only aggregator excerpts available'
    };
  }

  // Now we have fullText with 100+ chars - check if complete or truncated
  const truncation = detectTruncationSignals(fullText);

  // T1: COMPLETE - Full review with no truncation issues
  // Check ending - allow URLs, ticket info at end (common footer pattern)
  const trimmed = fullText.trim();
  let hasProperEnding = /[.!?"'"")\]]$/.test(trimmed) ||
    /\.(com|org|net|co\.uk)\/?$/.test(trimmed) ||
    /[.!?]\s*[A-DF][+-]?$/.test(trimmed);

  // If text has footer junk, the raw ending is unreliable.
  // Look for proper sentence ending before the footer region.
  if (!hasProperEnding && truncation.signals.includes('has_footer_junk')) {
    const backRegion = fullText.slice(-500);
    // Find earliest footer match position in last 500 chars
    let earliestFooter = backRegion.length;
    for (const pattern of TRUNCATION_SIGNALS.footer) {
      const m = backRegion.match(pattern);
      if (m && m.index < earliestFooter) earliestFooter = m.index;
    }
    // Check if text before footer has proper ending
    const beforeFooter = fullText.slice(0, fullText.length - 500 + earliestFooter).trim();
    if (/[.!?"'"")\]]$/.test(beforeFooter)) {
      hasProperEnding = true;
    }
  }

  const isLongEnough = wordCount >= 300 && charCount >= 1500;
  const isVeryLong = wordCount >= 500; // Very long reviews are likely complete
  const longerThanExcerpts = !hasExcerpt || charCount >= longestExcerptLen * 1.5;

  // Complete if: long enough with proper ending and no severe truncation
  // OR very long (500+ words) with no severe truncation (footer junk is OK)
  if (truncation.severeCount === 0 && longerThanExcerpts) {
    if ((isLongEnough && hasProperEnding && truncation.moderateCount <= 1) ||
        (isVeryLong && truncation.moderateCount <= 1)) {
      return {
        contentTier: 'complete',
        wordCount,
        truncationSignals: truncation.signals,
        tierReason: 'Full review text'
      };
    }
  }

  // Path 3: Short but structurally complete reviews (capsule reviews, Time Out, etc.)
  // Stricter structural requirements compensate for lower word count:
  // - ZERO truncation signals (not even moderate — no ellipsis, no missing punctuation)
  // - Must contain opinion/evaluative language (not just topic keywords)
  // - Must end with proper punctuation
  // - Must be longer than aggregator excerpts (relaxed 1.1x multiplier)
  const looseExcerptCheck = !hasExcerpt || charCount >= longestExcerptLen * 1.1;
  if (wordCount >= 150 && hasProperEnding &&
      truncation.severeCount === 0 && truncation.moderateCount === 0 &&
      truncation.signals.length === 0 &&
      looseExcerptCheck && hasOpinionLanguage(fullText)) {
    return {
      contentTier: 'complete',
      wordCount,
      truncationSignals: [],
      tierReason: 'Short but structurally complete review'
    };
  }

  // T2: TRUNCATED - Has text but known/likely incomplete
  return {
    contentTier: 'truncated',
    wordCount,
    truncationSignals: truncation.signals,
    tierReason: truncation.likelyTruncated
      ? `Truncation detected: ${truncation.signals.join(', ')}`
      : wordCount < 300
        ? `Short text (${wordCount} words)`
        : `Missing proper ending or other signals`
  };
}

/**
 * Get scraping priority for a review based on content tier
 * Higher number = higher priority for re-scraping
 *
 * @param {Object} review - Review with contentTier
 * @returns {{ priority: number, reason: string }}
 */
function getScrapingPriority(review) {
  const tier = review.contentTier;
  const hasUrl = !!review.url;

  switch (tier) {
    case 'truncated':
      return hasUrl
        ? { priority: 5, reason: 'Truncated with URL - try Archive.org or login' }
        : { priority: 2, reason: 'Truncated without URL - need to find URL first' };
    case 'excerpt':
      return hasUrl
        ? { priority: 4, reason: 'Excerpt only with URL - scrape full text' }
        : { priority: 1, reason: 'Excerpt only without URL - excerpts may suffice' };
    case 'stub':
      return hasUrl
        ? { priority: 3, reason: 'Stub with URL - attempt scraping' }
        : { priority: 0, reason: 'Stub without URL - lowest priority' };
    case 'needs-rescrape':
      return hasUrl
        ? { priority: 5, reason: 'Needs rescrape with URL - previous text was garbage' }
        : { priority: 2, reason: 'Needs rescrape without URL - find URL first' };
    case 'invalid':
      return { priority: -1, reason: 'Invalid - needs manual review or deletion' };
    case 'complete':
    default:
      return { priority: 0, reason: 'Complete - no action needed' };
  }
}

// ========================================
// BYLINE EXTRACTION (1B-i)
// ========================================

/**
 * Common byline patterns found at the start or end of review text.
 * @type {RegExp[]}
 */
const BYLINE_PATTERNS = [
  // "By Name" at start of text (within first 500 chars)
  /^(?:By|BY)\s+([A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+(?:-[A-Z][a-z]+)?)/m,
  // "— Name" or "– Name" (em dash attribution)
  /(?:—|–|--)\s*([A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+(?:-[A-Z][a-z]+)?)\s*$/m,
  // "Reviewed by Name" or "Reported by Name" (NOT "Written by" — always means playwright)
  /(?:Reviewed|Report(?:ed)?)\s+by\s+([A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+(?:-[A-Z][a-z]+)?)/i,
];

// Words that appear in false-positive byline matches (not person names)
const NON_NAME_WORDS = new Set([
  'prize', 'weekly', 'crown', 'theatre', 'theater', 'broadway',
  'award', 'playwright', 'starring', 'actual', 'norwegian',
  'american', 'entertainment', 'daily', 'musical', 'production'
]);

/**
 * Check if an extracted name is likely not a person name.
 * Rejects names where any word is a known non-name word.
 */
function isNonNameWord(name) {
  const parts = name.toLowerCase().split(/\s+/);
  return parts.some(p => NON_NAME_WORDS.has(p));
}

/**
 * Check if an extracted byline name matches a known show person (cast/creative).
 * Uses full last-name + 3-char first-name prefix matching.
 *
 * @param {string} matchedName - Name extracted from text
 * @param {string[]} excludeNames - Names to exclude (cast + creative team)
 * @returns {boolean}
 */
function isExcludedName(matchedName, excludeNames) {
  if (!excludeNames || excludeNames.length === 0) return false;
  const matched = normalizeName(matchedName);
  if (!matched) return false;
  const mParts = matched.split(' ').filter(p => p.length > 0);

  return excludeNames.some(name => {
    const excluded = normalizeName(name);
    if (!excluded) return false;

    // Exact match
    if (matched === excluded) return true;

    const eParts = excluded.split(' ').filter(p => p.length > 0);
    if (mParts.length < 2 || eParts.length < 2) return false;

    // Same last name + first name prefix (3+ chars) match
    const mLast = mParts[mParts.length - 1];
    const eLast = eParts[eParts.length - 1];
    if (mLast !== eLast) return false;

    const mFirst = mParts[0];
    const eFirst = eParts[0];
    const minLen = Math.min(mFirst.length, eFirst.length);
    if (minLen >= 3 && mFirst.substring(0, 3) === eFirst.substring(0, 3)) return true;

    return false;
  });
}

/**
 * Extract byline (author name) from review text.
 * Searches first 500 chars and last 200 chars for common byline patterns.
 *
 * @param {string} text - Review text
 * @param {Object} [options] - Options
 * @param {string[]} [options.excludeNames] - Names to exclude (cast/creative team)
 * @returns {{ found: boolean, name: string | null, position: 'start' | 'end' | null }}
 */
function extractByline(text, options = {}) {
  if (!text || text.length < 50) {
    return { found: false, name: null, position: null };
  }

  const startChunk = text.substring(0, 500);
  const endChunk = text.length > 200 ? text.substring(text.length - 200) : text;

  // Check start of text
  for (const pattern of BYLINE_PATTERNS) {
    const match = startChunk.match(pattern);
    if (match && match[1]) {
      const name = match[1].trim();
      if (isNonNameWord(name)) continue;
      if (isExcludedName(name, options.excludeNames)) continue;
      return { found: true, name, position: 'start' };
    }
  }

  // Check end of text
  for (const pattern of BYLINE_PATTERNS) {
    const match = endChunk.match(pattern);
    if (match && match[1]) {
      const name = match[1].trim();
      if (isNonNameWord(name)) continue;
      if (isExcludedName(name, options.excludeNames)) continue;
      return { found: true, name, position: 'end' };
    }
  }

  return { found: false, name: null, position: null };
}

// ========================================
// FUZZY CRITIC MATCHING (1B-ii)
// ========================================

/**
 * Normalize a name for comparison: lowercase, trim, collapse whitespace
 * @param {string} name
 * @returns {string}
 */
function normalizeName(name) {
  if (!name) return '';
  return name.toLowerCase().trim().replace(/\s+/g, ' ').replace(/[.,]/g, '');
}

/**
 * Check if an extracted byline name matches the expected critic name.
 * Handles: exact match, reversed order, last-name-only, abbreviated first name.
 *
 * @param {string} extractedName - Name found in the text
 * @param {string} expectedCritic - Expected critic name from metadata
 * @returns {boolean}
 */
function matchesCritic(extractedName, expectedCritic) {
  if (!extractedName || !expectedCritic) return false;

  const extracted = normalizeName(extractedName);
  const expected = normalizeName(expectedCritic);

  if (!extracted || !expected) return false;

  // 1. Exact match
  if (extracted === expected) return true;

  // Split into parts
  const extractedParts = extracted.split(' ').filter(p => p.length > 0);
  const expectedParts = expected.split(' ').filter(p => p.length > 0);

  if (extractedParts.length === 0 || expectedParts.length === 0) return false;

  // 2. Reversed order (e.g., "Green, Jesse" vs "Jesse Green")
  if (extractedParts.length >= 2 && expectedParts.length >= 2) {
    const extractedReversed = [...extractedParts].reverse().join(' ');
    if (extractedReversed === expected) return true;
  }

  // 3. Last name only match (e.g., "Green" matches "Jesse Green")
  const extractedLast = extractedParts[extractedParts.length - 1];
  const expectedLast = expectedParts[expectedParts.length - 1];
  if (extractedParts.length === 1 && extractedLast === expectedLast) return true;
  if (expectedParts.length === 1 && expectedLast === extractedLast) return true;

  // 4. Abbreviated first name (e.g., "J. Green" matches "Jesse Green")
  if (extractedParts.length >= 2 && expectedParts.length >= 2) {
    // Last names must match
    if (extractedLast !== expectedLast) return false;

    const extractedFirst = extractedParts[0];
    const expectedFirst = expectedParts[0];

    // Check if one is an abbreviation of the other
    if (extractedFirst.length <= 2 && expectedFirst.startsWith(extractedFirst.replace('.', ''))) return true;
    if (expectedFirst.length <= 2 && extractedFirst.startsWith(expectedFirst.replace('.', ''))) return true;
  }

  return false;
}

// ========================================
// CONTENT FINGERPRINT / HASH DEDUP (1C)
// ========================================

/**
 * Compute a content fingerprint for deduplication.
 * Normalizes text (lowercase, strip whitespace/punctuation), takes first N chars, and hashes.
 *
 * @param {string} text - Review text
 * @param {number} [length=500] - Number of chars to use for fingerprint
 * @returns {string} - Hex digest fingerprint
 */
function computeContentFingerprint(text, length = 500) {
  if (!text || text.trim().length === 0) return '';

  // Normalize: lowercase, strip whitespace and punctuation, take first N chars
  const normalized = text.toLowerCase()
    .replace(/[\s\r\n]+/g, '')
    .replace(/[^a-z0-9]/g, '')
    .substring(0, length);

  if (normalized.length < 50) return ''; // Too short to fingerprint

  // Simple hash (djb2) - no need for crypto dependency
  let hash = 5381;
  for (let i = 0; i < normalized.length; i++) {
    hash = ((hash << 5) + hash) + normalized.charCodeAt(i);
    hash = hash & hash; // Convert to 32-bit integer
  }

  return Math.abs(hash).toString(16).padStart(8, '0');
}

/**
 * Detect garbage from LLM reasoning text.
 * When LLM confidence is "low" and reasoning matches known patterns indicating
 * the text is not a real review, flag it for re-scraping.
 *
 * @param {string} reasoning - The LLM reasoning text
 * @param {string} confidence - The LLM confidence level
 * @returns {{ isGarbage: boolean, matchedPattern: string|null }}
 */
function detectGarbageFromReasoning(reasoning, confidence) {
  if (!reasoning || confidence !== 'low') {
    return { isGarbage: false, matchedPattern: null };
  }

  const lowerReasoning = reasoning.toLowerCase();

  const GARBAGE_PATTERNS = [
    { pattern: 'not a review', label: 'not-a-review' },
    { pattern: 'not a theater review', label: 'not-a-theater-review' },
    { pattern: 'not a broadway review', label: 'not-a-broadway-review' },
    { pattern: 'plot summary without evaluation', label: 'plot-summary-only' },
    { pattern: 'headline only', label: 'headline-only' },
    { pattern: 'appears to be an advertisement', label: 'advertisement' },
    { pattern: 'paid placement', label: 'paid-placement' },
    { pattern: 'press release', label: 'press-release' },
    { pattern: 'not related to', label: 'unrelated-content' },
    { pattern: 'completely unrelated', label: 'unrelated-content' },
    { pattern: 'wrong article', label: 'wrong-article' },
    { pattern: 'different show', label: 'different-show' },
    { pattern: 'news feed', label: 'news-feed' },
    { pattern: 'news article', label: 'news-article' },
    { pattern: 'health article', label: 'health-article' },
    { pattern: 'drug disposal', label: 'wrong-content' },
    { pattern: 'no review content', label: 'no-review-content' }
  ];

  for (const { pattern, label } of GARBAGE_PATTERNS) {
    if (lowerReasoning.includes(pattern)) {
      return { isGarbage: true, matchedPattern: label };
    }
  }

  return { isGarbage: false, matchedPattern: null };
}

// ========================================
// CONTENT-TO-SHOW VERIFICATION (1D)
// ========================================

/**
 * Common English words that are also surnames — skip these in name matching
 * to avoid false positives (e.g., "Young" appearing in review text ≠ director named Young).
 * @type {Set<string>}
 */
const COMMON_WORD_NAMES = new Set([
  'young', 'lee', 'green', 'white', 'king', 'rose', 'grace', 'grey', 'gray',
  'long', 'stone', 'wood', 'fields', 'love', 'page', 'rice', 'cross', 'bell',
  'day', 'park', 'fox', 'wolf', 'ford', 'chase', 'rich', 'wall', 'grant',
  'joy', 'hope', 'may', 'mark', 'art', 'new', 'best', 'fine', 'bright',
  'strong', 'fair', 'sharp', 'will', 'cash', 'bush', 'lane', 'miles',
]);

/**
 * Check if a person name appears in text, with safeguards against false positives.
 *
 * @param {string} text - Lowercased review text
 * @param {string} name - Person name (e.g., "Marc Bruni")
 * @returns {boolean}
 */
function nameFoundInText(text, name) {
  if (!name || !text) return false;

  const parts = name.toLowerCase().replace(/-/g, ' ').trim().split(/\s+/).filter(p => p.length > 0);
  if (parts.length === 0) return false;

  const lastName = parts[parts.length - 1];
  const firstName = parts[0];

  // Skip if last name is a common English word
  if (COMMON_WORD_NAMES.has(lastName)) {
    // For common-word last names, require BOTH first and last name present
    if (parts.length >= 2 && firstName.length >= 3) {
      return text.includes(firstName) && text.includes(lastName);
    }
    return false;
  }

  // Short last names (<5 chars) require first+last to avoid false positives
  if (lastName.length < 5 && parts.length >= 2) {
    return text.includes(firstName) && text.includes(lastName);
  }

  // For longer last names, last name alone is sufficient
  // Also try hyphen-stripped version ("Lin-Manuel" → "lin manuel")
  const nameNormalized = name.toLowerCase().replace(/-/g, ' ');
  if (text.includes(nameNormalized)) return true;
  if (text.includes(lastName)) return true;

  return false;
}

/**
 * Broadway venue aliases — groups of names that refer to the same physical theater
 * or to a producer that uses that theater as its Broadway home.
 *
 * Without this map the content classifier marks reviews "Wrong production"
 * when a critic names the producing company instead of the venue, e.g. an
 * NYSR review of a Becky Shaw revival at the Hayes Theater that says
 * "Second Stage Theater" (Second Stage's Broadway home is the Hayes).
 *
 * Each inner array is a group: any one alias matched in review text is
 * sufficient to count as a venue-name hit for any show whose venue is in the
 * same group.
 */
const VENUE_ALIAS_GROUPS = [
  // Hayes Theater — Second Stage's Broadway home
  ['Hayes Theater', 'Helen Hayes Theater', 'Helen Hayes Theatre', 'Second Stage Theater', 'Second Stage Theatre', 'Second Stage'],
  // Friedman Theatre — Manhattan Theatre Club's Broadway home
  ['Samuel J. Friedman Theatre', 'Friedman Theatre', 'Friedman Theater', 'Manhattan Theatre Club', 'Manhattan Theater Club', 'MTC'],
  // Lincoln Center Theater — three venues
  ['Vivian Beaumont Theater', 'Vivian Beaumont Theatre', 'Beaumont Theater', 'Beaumont Theatre', 'Lincoln Center Theater', 'Lincoln Center Theatre', 'LCT'],
  ['Mitzi E. Newhouse Theater', 'Newhouse Theater', 'Mitzi Newhouse', 'Lincoln Center Theater', 'LCT'],
  // Roundabout Theatre Company — multiple Broadway venues
  ['American Airlines Theatre', 'American Airlines Theater', 'Roundabout Theatre Company', 'Roundabout Theatre', 'Roundabout'],
  ['Studio 54', 'Roundabout Theatre Company', 'Roundabout'],
  ['Stephen Sondheim Theatre', 'Sondheim Theatre', 'Sondheim Theater', 'Roundabout Theatre Company', 'Roundabout'],
  ['Todd Haimes Theatre', 'Todd Haimes Theater', 'Roundabout Theatre Company', 'Roundabout'],
  // Lyceum — sometimes referred to by producer
  ['Lyceum Theatre', 'Lyceum Theater'],
  // City Center Encores — at NY City Center (counted as Broadway when the producer says so)
  ['New York City Center', 'NY City Center', 'City Center Encores', 'Encores'],
];

const _venueAliasIndex = (() => {
  const map = new Map();
  for (const group of VENUE_ALIAS_GROUPS) {
    for (const alias of group) {
      const key = alias.toLowerCase().replace(/\s+/g, ' ').trim();
      if (!map.has(key)) map.set(key, group);
    }
  }
  return map;
})();

/**
 * Return all alias names for a given venue. Always includes the venue itself
 * even if no alias group is registered.
 */
function getVenueAliasGroup(venue) {
  if (!venue) return [];
  const key = venue.toLowerCase().replace(/\s+/g, ' ').trim();
  const group = _venueAliasIndex.get(key);
  if (group) return group;
  return [venue];
}

/**
 * Verify whether fullText content matches the expected show.
 *
 * Uses weighted signals from show metadata (title, director, venue, cast, creative team)
 * to determine if the scraped text is actually about the right show. Designed to catch
 * wrong-show content (film reviews, different productions, unrelated articles) while
 * minimizing false positives.
 *
 * Key design decisions (informed by critique review):
 * - Title matching uses word-level matching, not just exact substring, to handle
 *   informal names ("Gatsby" for "The Great Gatsby", "Outsiders" for "The Outsiders")
 * - Film/movie penalty REMOVED: 40%+ of Broadway shows are adaptations where critics
 *   routinely compare stage to screen — this caused mass false deletions in testing
 * - Auto-null threshold requires score <= -5 with 2+ independent negative signals
 *   (the function returns the score; callers enforce the threshold)
 * - Reuses show title list from loadBroadwayShows() for "wrong show" detection
 *
 * @param {string} fullText - The review full text to verify
 * @param {Object} showMetadata - Show object from shows.json
 * @param {string} showMetadata.title - Show title
 * @param {string} [showMetadata.venue] - Theater/venue name
 * @param {Array<{name: string, role: string}>} [showMetadata.creativeTeam] - Creative team
 * @param {Array<{name: string}>} [showMetadata.cast] - Cast members
 * @param {string} [showMetadata.id] - Show ID (e.g., "great-gatsby-2024")
 * @returns {{
 *   verdict: 'confident_match' | 'probable_match' | 'uncertain' | 'probable_mismatch' | 'confident_mismatch',
 *   score: number,
 *   negativeSignalCount: number,
 *   positiveSignals: string[],
 *   negativeSignals: string[],
 *   details: { titleFound: boolean, directorFound: boolean, venueFound: boolean, castFound: number, wrongShowMentioned: string|null }
 * }}
 */
function verifyFullTextContent(fullText, showMetadata) {
  if (!fullText || !showMetadata) {
    return {
      verdict: 'uncertain',
      score: 0,
      negativeSignalCount: 0,
      positiveSignals: [],
      negativeSignals: ['Missing fullText or showMetadata'],
      details: { titleFound: false, directorFound: false, venueFound: false, castFound: 0, wrongShowMentioned: null }
    };
  }

  // Normalize text: lowercase and normalize apostrophes/quotes for matching
  const text = fullText.toLowerCase().replace(/[\u2018\u2019\u201C\u201D\u2032\u2033]/g, c =>
    c === '\u2018' || c === '\u2019' || c === '\u2032' ? "'" : '"'
  );
  const title = (showMetadata.title || '').toLowerCase().trim().replace(/[\u2018\u2019\u201C\u201D\u2032\u2033]/g, c =>
    c === '\u2018' || c === '\u2019' || c === '\u2032' ? "'" : '"'
  );
  let score = 0;
  const positiveSignals = [];
  const negativeSignals = [];
  let negativeSignalCount = 0;
  const details = {
    titleFound: false,
    directorFound: false,
    venueFound: false,
    castFound: 0,
    wrongShowMentioned: null
  };

  // --- POSITIVE SIGNALS ---

  // 1. Show title check (+3)
  // Use multiple matching strategies to handle informal names
  if (title.length > 0) {
    let titleFound = false;

    // Exact title match
    if (text.includes(title)) {
      titleFound = true;
    }

    // Without "The"/"A"/"An" prefix
    if (!titleFound) {
      const withoutArticle = title.replace(/^(the|a|an)\s+/, '');
      if (withoutArticle.length > 3 && text.includes(withoutArticle)) {
        titleFound = true;
      }
    }

    // Title words check: for multi-word titles, check if significant words appear
    // This handles "Gatsby" for "The Great Gatsby", "Outsiders" for "The Outsiders"
    if (!titleFound) {
      const titleWords = title
        .replace(/^(the|a|an)\s+/, '')
        .replace(/['']/g, '') // Strip apostrophes so "doll's" → "dolls", matches text "dolls"
        .split(/[\s:,\-–—]+/)
        .filter(w => w.length > 3 && !['the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'part', 'musical'].includes(w));

      // Also search in apostrophe-stripped text
      const textNoApostrophe = text.replace(/['']/g, '');

      if (titleWords.length > 0) {
        const matchedWords = titleWords.filter(w => text.includes(w) || textNoApostrophe.includes(w));
        // For single-word titles, require exact match
        // For multi-word titles, require half of significant words (50% threshold)
        // 50% catches "A Bronx Tale The Musical" matching on "bronx" + "tale" (2/3)
        if (titleWords.length === 1 && matchedWords.length === 1) {
          titleFound = true;
        } else if (titleWords.length >= 2 && matchedWords.length >= Math.ceil(titleWords.length * 0.5)) {
          titleFound = true;
        }
      }
    }

    // Check show ID words as fallback (e.g., "back-to-the-future-2023" → "back", "future")
    if (!titleFound && showMetadata.id) {
      const idBase = showMetadata.id.replace(/-\d{4}$/, '');
      const idWords = idBase.split('-').filter(w => w.length > 4 && !['the', 'and', 'for'].includes(w));
      if (idWords.length >= 2) {
        const matchedIdWords = idWords.filter(w => text.includes(w));
        if (matchedIdWords.length >= 2) {
          titleFound = true;
        }
      }
    }

    if (titleFound) {
      score += 3;
      positiveSignals.push(`Show title "${showMetadata.title}" found in text`);
      details.titleFound = true;
    }
  }

  // 2. Director name (+2)
  const creativeTeam = showMetadata.creativeTeam || [];
  const directors = creativeTeam.filter(c =>
    c.role && c.role.toLowerCase().includes('direct')
  );
  for (const director of directors) {
    if (nameFoundInText(text, director.name)) {
      score += 2;
      positiveSignals.push(`Director "${director.name}" found`);
      details.directorFound = true;
      break; // Only count once
    }
  }

  // 3. Theater/venue name (+1) — checks the venue and its aliases.
  // Many Broadway theaters are referenced by producer name or shortened form
  // ("Second Stage Theater" for Hayes Theater = Second Stage's Broadway home;
  // "MTC" for Friedman Theatre, etc.). Without alias awareness the classifier
  // flags accurate reviews as wrongProduction.
  if (showMetadata.venue) {
    const aliasGroups = getVenueAliasGroup(showMetadata.venue);
    let venueHit = null;
    for (const alias of aliasGroups) {
      const venueWords = alias.toLowerCase().replace(/\s*(theatre|theater)\s*/gi, '').trim();
      if (venueWords.length > 3 && text.includes(venueWords)) {
        venueHit = alias;
        break;
      }
    }
    if (venueHit) {
      score += 1;
      positiveSignals.push(`Venue "${showMetadata.venue}" found${venueHit !== showMetadata.venue ? ` (via alias "${venueHit}")` : ''}`);
      details.venueFound = true;
    }
  }

  // 4. Cast members (+2 if 2+ found)
  const cast = showMetadata.cast || [];
  if (cast.length > 0) {
    let castMatches = 0;
    for (const member of cast) {
      if (nameFoundInText(text, member.name)) {
        castMatches++;
        if (castMatches >= 2) break;
      }
    }
    if (castMatches >= 2) {
      score += 2;
      positiveSignals.push(`${castMatches} cast members found`);
      details.castFound = castMatches;
    }
  }

  // 5. Other creative team (choreographer, playwright, composer) (+1 each, cap +2)
  let creativeBonus = 0;
  const nonDirectorCreative = creativeTeam.filter(c =>
    c.role && !c.role.toLowerCase().includes('direct') &&
    /choreograph|book|music|lyrics|playwright|compos/i.test(c.role)
  );
  for (const person of nonDirectorCreative) {
    if (nameFoundInText(text, person.name)) {
      creativeBonus++;
      positiveSignals.push(`Creative team "${person.name}" (${person.role}) found`);
      if (creativeBonus >= 2) break;
    }
  }
  score += Math.min(creativeBonus, 2);

  // --- NEGATIVE SIGNALS ---

  // 6. Show title NOT found (-3)
  if (!details.titleFound && title.length > 0) {
    score -= 3;
    negativeSignals.push(`Show title "${showMetadata.title}" not found in text`);
    negativeSignalCount++;
  }

  // 7. Different show title mentioned 3+ times (-2)
  // Use cached show titles from loadBroadwayShows()
  const allShowTitles = loadBroadwayShows();
  const titleLower = title.toLowerCase();
  for (const otherTitle of allShowTitles) {
    // Skip if it's the current show or a substring of the current show
    if (otherTitle === titleLower) continue;
    if (titleLower.includes(otherTitle) || otherTitle.includes(titleLower)) continue;
    // Skip very short titles that match common words
    if (otherTitle.length <= 4) continue;

    // Count occurrences
    let count = 0;
    let searchStart = 0;
    while (searchStart < text.length) {
      const idx = text.indexOf(otherTitle, searchStart);
      if (idx === -1) break;
      count++;
      searchStart = idx + otherTitle.length;
      if (count >= 3) break;
    }

    if (count >= 3) {
      score -= 2;
      negativeSignals.push(`Different show "${otherTitle}" mentioned ${count}+ times`);
      negativeSignalCount++;
      details.wrongShowMentioned = otherTitle;
      break; // Only flag the first wrong show
    }
  }

  // --- VERDICT ---
  let verdict;
  if (score >= 3) {
    verdict = 'confident_match';
  } else if (score >= 1) {
    verdict = 'probable_match';
  } else if (score === 0) {
    verdict = 'uncertain';
  } else if (score >= -2) {
    verdict = 'probable_mismatch';
  } else {
    verdict = 'confident_mismatch';
  }

  return {
    verdict,
    score,
    negativeSignalCount,
    positiveSignals,
    negativeSignals,
    details
  };
}

// ========================================
// AUTHOR EXTRACTION FROM HTML (1B-iii)
// ========================================
// Multi-strategy author extraction: meta tags → JSON-LD → byline CSS → text byline.

function isValidAuthorName(name) {
  if (!name) return false;
  const trimmed = name.trim();
  if (trimmed.length < 3 || trimmed.length > 60) return false;
  if (trimmed.includes('<') || trimmed.includes('>')) return false;
  if (trimmed.includes('http') || trimmed.includes('www')) return false;
  const words = trimmed.split(/\s+/);
  if (words.length < 2 || words.length > 5) return false;
  const skipNames = ['the new', 'associated press', 'nbc', 'abc', 'cbs', 'fox', 'bloomberg',
                     'entertainment weekly', 'time out', 'daily news', 'new york',
                     'los angeles', 'chicago tribune', 'washington post', 'staff writer',
                     'staff reporter', 'theater critic', 'drama critic', 'theatre critic',
                     'arts editor', 'culture editor', 'guest writer', 'special to',
                     'tribune news', 'news service', 'wire service'];
  if (skipNames.some(s => trimmed.toLowerCase().includes(s))) return false;
  return true;
}

function cleanAuthorName(name) {
  let cleaned = name.trim();
  // Strip any residual HTML tags (e.g., "Lisa Martland<br>")
  cleaned = cleaned.replace(/<[^>]+>/g, '').trim();
  // Strip HTML entities
  cleaned = cleaned.replace(/&[a-z]+;/gi, '').trim();
  cleaned = cleaned.replace(/^By\s+/i, '');
  // Strip sentence-start prefixes that leak into critic names from text extraction
  // (e.g., "Although Dominic Cavendish", "For Chris Omaweng", "Only Andrzej Lukowski")
  cleaned = cleaned.replace(/^(?:Although|For|Only|When|While|Since|Because|But|And|With|From|Despite|Unlike|After|Before|During|Reviews?)\s+/i, '');
  // Strip wire service suffixes (AP, Associated, Associated Press, Reuters)
  cleaned = cleaned.replace(/\s+(?:Associated(?:\s+Press)?|AP|Reuters|UPI)\s*$/i, '').trim();
  cleaned = cleaned.replace(/[,;|]+$/, '').trim();
  // Fix double punctuation (e.g., "A.. " → "A. ")
  cleaned = cleaned.replace(/\.{2,}/g, '.');
  // Title-case: convert ALL CAPS to proper case, preserve abbreviations and small words
  const PRESERVE_UPPER = new Set(['II', 'III', 'IV', 'UK', 'US', 'USA', 'NYC', 'THR', 'NBC', 'CBS', 'AP']);
  const KEEP_LOWER = new Set(['and', 'or', 'the', 'of', 'in', 'for', 'to', 'by', 'de', 'van', 'von', 'di', 'del', 'la', 'le', 'el']);
  cleaned = cleaned.split(/\s+/).filter(Boolean).map((w, i) => {
    if (w.length <= 2) return w;
    if (PRESERVE_UPPER.has(w.toUpperCase())) return w.toUpperCase();
    if (/^[A-Z]\./.test(w)) return w; // Preserve dot-separated initials (A.R.)
    if (/^\(/.test(w)) return w; // Preserve parenthetical words as-is
    if (i > 0 && KEEP_LOWER.has(w.toLowerCase())) return w.toLowerCase();
    // If word is all-caps, convert to title case
    if (w === w.toUpperCase()) return w[0].toUpperCase() + w.slice(1).toLowerCase();
    return w[0].toUpperCase() + w.slice(1);
  }).join(' ');
  return cleaned;
}

/**
 * Extract author name from HTML using multiple strategies.
 * Priority: meta tags → JSON-LD → byline CSS → text-based extractByline()
 */
function extractAuthorFromHtml(html, text, options = {}) {
  if (!html) return null;

  const metaPatterns = [
    /<meta\s+name="author"\s+content="([^"]+)"/i,
    /<meta\s+content="([^"]+)"\s+name="author"/i,
    /<meta\s+property="article:author"\s+content="([^"]+)"/i,
    /<meta\s+content="([^"]+)"\s+property="article:author"/i,
    /<meta\s+property="mrf:authors"\s+content="([^"]+)"/i,
    /<meta\s+name="parsely-author"\s+content="([^"]+)"/i,
    /<meta\s+content="([^"]+)"\s+name="parsely-author"/i,
  ];
  for (const pattern of metaPatterns) {
    const match = html.match(pattern);
    if (match && isValidAuthorName(match[1])) return cleanAuthorName(match[1]);
  }

  const jsonLdPatterns = [
    /"author"\s*:\s*\[\s*\{[^}]*"name"\s*:\s*"([^"]+)"/i,
    /"author"\s*:\s*\{\s*"@type"\s*:\s*"Person"[^}]*"name"\s*:\s*"([^"]+)"/i,
    /"author"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"/i,
    /"author"\s*:\s*"([A-Z][a-z]+ [A-Z][a-z]+[^"]*)"/,
    /"author"\s*:\s*\[\s*"([A-Z][a-z]+ [A-Z][a-z]+[^"]*)"\s*\]/,
  ];
  for (const pattern of jsonLdPatterns) {
    const match = html.match(pattern);
    if (match && isValidAuthorName(match[1])) return cleanAuthorName(match[1]);
  }

  const bylinePatterns = [
    /class="[^"]*byline[^"]*"[^>]*>(?:<[^>]+>)*\s*(?:By\s+)?([A-Z][a-z]+ [A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i,
    /class="article-byline"[^>]*>\s*(?:By\s+)?([A-Z][a-z]+ [A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i,
    /itemprop="author"[^>]*>(?:<[^>]+>)*\s*([A-Z][a-z]+ [A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i,
    /rel="author"[^>]*>([A-Z][a-z]+ [A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i,
    // class="author" or class="foo author" — matches Theatrely, other CMS sites
    // Does NOT match class="author-area" or class="authors-box" (hyphen/plural after "author")
    /class="(?:[^"]*\s)?author"[^>]*>(?:\s*<[^>]+>)*\s*(?:By\s+)?([A-Z][a-z]+ [A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i,
    // class="author-name" — matches WhatsOnStage, DCTheatreScene
    /class="[^"]*author-name[^"]*"[^>]*>(?:\s*<[^>]+>)*\s*([A-Z][a-z]+ [A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i,
    // WordPress author vcard microformat
    /class="author vcard"[^>]*>(?:\s*<[^>]+>)*\s*([A-Z][a-z]+ [A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/i,
    // Talkin' Broadway: "<p>Theatre Review by <a href="mailto:...">Name</a> - Date</p>"
    // The anchor typically wraps a mailto: link; tolerate bio links and the
    // no-anchor variant. Name charset allows hyphens (Mary-Louise), ASCII and
    // curly apostrophes (Sean O'Connor / Sean O’Connor), and accented letters
    // (Zoë Anderson). Case-sensitive on "Theatre Review by" to reject mid-body
    // sentences containing "theatre review by". See memory/feedback_tb_mailto_byline.md.
    /Theatre Review by\s+(?:<a\b[^>]*>\s*)?([A-Z][A-Za-zÀ-ÿ'’\-]+(?:\s+[A-Z][A-Za-zÀ-ÿ'’\-]+){0,3})(?:\s*<\/a>)?/,
  ];
  for (const pattern of bylinePatterns) {
    const match = html.match(pattern);
    if (match && isValidAuthorName(match[1])) return cleanAuthorName(match[1]);
  }

  if (text) {
    const bylineResult = extractByline(text, options);
    if (bylineResult.found && isValidAuthorName(bylineResult.name)) {
      return cleanAuthorName(bylineResult.name);
    }
  }

  // Outlet-specific fallback for WSJ theater. WSJ's HTML structure and paywall
  // chrome routinely defeat our generic byline extractors, leaving criticName
  // 'Unknown' on real Charles Isherwood reviews. Since Charles Isherwood has
  // been the sole WSJ theater critic since Terry Teachout died 2022-01-13,
  // a WSJ theater review with a post-2022 publishDate is overwhelmingly likely
  // his. This is a soft fallback — the guard tags it _bylineInferred so callers
  // can audit/override.
  if (options && options.url && options.publishDate) {
    const inferred = inferWsjTheaterByline(options.url, options.publishDate);
    if (inferred) return inferred;
  }

  return null;
}

/**
 * Infer WSJ theater byline when extractors fail.
 * Returns null unless URL is unambiguously a WSJ theater review and publishDate
 * is within the Charles-Isherwood-only era (2022-04 onward, after Teachout's
 * last published reviews cleared).
 */
function inferWsjTheaterByline(url, publishDate) {
  if (!url || !publishDate) return null;
  const u = String(url).toLowerCase();
  if (!u.includes('wsj.com')) return null;
  // Theater reviews live at /articles/* with -review- or -theater- in slug
  const looksTheater = /-review-/.test(u) || u.includes('/theater/') || u.includes('-broadway-') || u.includes('-musical-') || u.includes('-play-');
  if (!looksTheater) return null;
  // Use article date — Isherwood replaced Teachout effective ~2022-04
  const iso = (() => {
    const s = String(publishDate);
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const t = Date.parse(s);
    return isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
  })();
  if (!iso || iso < '2022-04-01') return null;
  return 'Charles Isherwood';
}

/**
 * Extract a high-confidence author name from HTML.
 *
 * High-confidence = the article itself declares the author via structured data
 * that CMSs emit per-article (not per-site). The site-masthead meta name="author"
 * is EXCLUDED because it's commonly the outlet's editor-in-chief, not the piece's
 * byline (failure mode observed 2026-04-19: NYTG masthead name "Gillian Russo"
 * kept overriding the real review author "Allison Considine").
 *
 * Sources checked (in priority order):
 *   1. <meta property="article:author"> — OG/FB-standard per-article field
 *   2. JSON-LD  "author":{"@type":"Person","name":...}  — schema.org per-article
 *
 * Returns { name, source } on match, null otherwise.
 */
function extractHighConfidenceAuthor(html) {
  if (!html) return null;

  const articleAuthorPatterns = [
    /<meta\s+property="article:author"\s+content="([^"]+)"/i,
    /<meta\s+content="([^"]+)"\s+property="article:author"/i,
  ];
  for (const pattern of articleAuthorPatterns) {
    const m = html.match(pattern);
    if (m && isValidAuthorName(m[1])) {
      return { name: cleanAuthorName(m[1]), source: 'article:author' };
    }
  }

  // JSON-LD @type=Person anchored tightly — requires the Person type to appear
  // before the name inside the author object. Looser jsonLdPatterns in
  // extractAuthorFromHtml include a catch-all that matches editor@graph nodes
  // and sidebar widgets; those aren't safe overrides.
  const personJsonLd = html.match(/"author"\s*:\s*\{\s*"@type"\s*:\s*"Person"[^}]*"name"\s*:\s*"([^"]+)"/i);
  if (personJsonLd && isValidAuthorName(personJsonLd[1])) {
    return { name: cleanAuthorName(personJsonLd[1]), source: 'jsonld-person' };
  }
  // Also allow name-before-@type shape (order-agnostic) by bounding to short objects
  const personJsonLd2 = html.match(/"author"\s*:\s*\{\s*"name"\s*:\s*"([^"]+)"[^}]*"@type"\s*:\s*"Person"/i);
  if (personJsonLd2 && isValidAuthorName(personJsonLd2[1])) {
    return { name: cleanAuthorName(personJsonLd2[1]), source: 'jsonld-person' };
  }

  return null;
}

/**
 * Post-fetch URL→content sanity check (Schmigadoon 2026 Bug #2).
 *
 * Before persisting fullText fetched from a URL we believe is a review of SHOW_X,
 * verify the content actually mentions SHOW_X enough to trust it. This catches
 * the class of failure where BrightData/ScrapingBee returns a completely
 * different article (e.g., Everybody's Talking About Jamie content served on
 * a Schmigadoon URL due to CDN misrouting, stale cache, or wrong-slug redirect).
 *
 * Two independent checks, BOTH must pass:
 *   1. Body mention count: the show title (or significant show-ID word) appears
 *      at least N times, where N scales with text length.
 *   2. HTML <title> match (when html provided): the <title> contains a
 *      significant title word or ID word — a completely unrelated title is a
 *      strong signal we fetched the wrong page.
 *
 * Returns { valid, reason, mentionCount, threshold, htmlTitle, htmlTitleMatch }.
 *
 * @param {string} text - The fetched fullText (post-cleaning)
 * @param {string} [html] - Raw HTML (for <title> check, optional)
 * @param {string} showTitle - Human-readable show title (e.g., "Schmigadoon")
 * @param {string} [showId] - Show ID slug (e.g., "schmigadoon-2026")
 * @param {Object} [opts]
 * @param {number} [opts.minMentionsLong=3] - Threshold for text ≥1500 chars
 * @param {number} [opts.minMentionsShort=1] - Threshold for text <1500 chars
 * @returns {{ valid: boolean, reason?: string, mentionCount: number, threshold: number, htmlTitle: string|null, htmlTitleMatch: boolean|null }}
 */
function validateContentMentionsShow(text, html, showTitle, showId, opts = {}) {
  const minLong = opts.minMentionsLong != null ? opts.minMentionsLong : 3;
  const minShort = opts.minMentionsShort != null ? opts.minMentionsShort : 1;

  if (!text || typeof text !== 'string') {
    return {
      valid: false,
      reason: 'empty text',
      mentionCount: 0,
      threshold: minShort,
      htmlTitle: null,
      htmlTitleMatch: null,
    };
  }

  // Normalize curly quotes/dashes to straight ASCII before matching. shows.json
  // uses straight apostrophes ("Joe Turner's") while many outlets render curly
  // ones ("Joe Turner's") — without normalization the multi-word title token
  // never matches and short paywalled excerpts get rejected as
  // url_content_mismatch (NY Sun Joe Turner 2026-04-26 incident).
  // Includes U+02BC (modifier-letter apostrophe), U+FF07 (full-width
  // apostrophe), and U+00A0 (NBSP) — collapse NBSP to regular space so
  // "Joe Turner's" with NBSP between words still matches.
  const normalize = (s) => s
    .replace(/[‘’‚‛ʼ＇]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/ /g, ' ');
  const lower = normalize(text).toLowerCase();
  const threshold = text.length >= 1500 ? minLong : minShort;

  // Build the set of title tokens to count — show title, title-without-"The",
  // significant ID words. One occurrence of ANY token counts toward the total
  // (we're asking "does this page really cover SHOW_X?", not "is the exact
  // official title used 3 times"). De-duplicate tokens so "Schmigadoon" in
  // both title and ID doesn't double-weight.
  const tokens = new Set();
  if (showTitle && showTitle.length > 2) {
    const t = normalize(showTitle).toLowerCase();
    tokens.add(t);
    const noThe = t.replace(/^the\s+/, '');
    if (noThe.length > 2) tokens.add(noThe);
    // For possessive titles add the prefix before "'s" as a token — body text
    // typically uses the short form. Two patterns:
    // - Multi-word possessive ("Joe Turner's Come and Gone" → "Joe Turner")
    // - Single-word possessive ("Hell's Kitchen" → "Hell", "Marvin's Room"
    //   → "Marvin"). 47 shows in the catalog are single-word possessive; the
    //   original `/\s/` check filtered all of them out — caught in QA review
    //   2026-04-27. Joe Turner 2026-04-26 incident is the multi-word case.
    // Match either "'s " (with space) for mid-title or "'s" before EOL for
    // titles ending in possessive ("Hell's"). Threshold of 2 chars catches
    // "It's"/"Amy's"/"Who's" prefixes.
    const apostropheMatch = /^([^']{2,})'s(\s|$)/.exec(t);
    if (apostropheMatch) {
      const prefix = apostropheMatch[1].trim();
      if (prefix.length >= 2) tokens.add(prefix);
    }
  }
  if (showId) {
    const idBase = showId.replace(/-\d{4}$/, '');
    for (const w of idBase.split('-')) {
      if (w.length > 4 && !['the', 'and', 'for', 'with', 'from'].includes(w)) {
        tokens.add(w.toLowerCase());
        // Also add singular form of plural ID words (>5 chars to avoid noise):
        // "turners" → "turner" matches the natural body usage. Joe Turner.
        if (w.length > 5 && w.endsWith('s')) tokens.add(w.slice(0, -1).toLowerCase());
      }
    }
  }

  let mentionCount = 0;
  for (const token of tokens) {
    if (!token) continue;
    // Count non-overlapping occurrences, word-boundary when single word.
    const isSingleWord = !/\s/.test(token);
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = isSingleWord
      ? new RegExp(`\\b${escaped}\\b`, 'gi')
      : new RegExp(escaped, 'gi');
    const matches = lower.match(re);
    if (matches) mentionCount += matches.length;
  }

  // HTML <title> check (optional — only when html is provided)
  let htmlTitle = null;
  let htmlTitleMatch = null;
  if (html && typeof html === 'string') {
    const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (m) {
      htmlTitle = m[1].replace(/\s+/g, ' ').trim();
      const titleLower = normalize(htmlTitle).toLowerCase();
      htmlTitleMatch = false;
      for (const token of tokens) {
        if (token && titleLower.includes(token)) {
          htmlTitleMatch = true;
          break;
        }
      }
    }
  }

  // When the HTML <title> matches the show, the URL is provably correct — relax
  // the body-mention threshold by 1 (but require at least 1 body mention so a
  // title-only page can't sneak through). Beaches NY Sun 2026-04-27: paywalled
  // article with `htmlTitleMatch=true` and 2 body mentions of "Beaches" was
  // being rejected against the 3-mention threshold for >1500-char text.
  const effectiveThreshold = (htmlTitleMatch === true && mentionCount >= 1)
    ? Math.max(1, threshold - 1)
    : threshold;

  if (mentionCount < effectiveThreshold) {
    return {
      valid: false,
      reason: `show mentioned ${mentionCount}× (below ${effectiveThreshold} threshold for ${text.length}-char text${htmlTitleMatch === true ? ', titleMatch=true' : ''})`,
      mentionCount,
      threshold,
      htmlTitle,
      htmlTitleMatch,
    };
  }

  if (htmlTitleMatch === false) {
    return {
      valid: false,
      reason: `HTML <title> "${htmlTitle}" does not reference show "${showTitle || showId}"`,
      mentionCount,
      threshold,
      htmlTitle,
      htmlTitleMatch,
    };
  }

  return {
    valid: true,
    mentionCount,
    threshold,
    htmlTitle,
    htmlTitleMatch,
  };
}

module.exports = {
  isGarbageContent,
  hasReviewContent,
  assessTextQuality,
  detectGarbageFromReasoning,
  // New enhanced validation functions
  validateShowMentioned,
  validateContentMentionsShow,
  detectMultiShowContent,
  detectConcatenatedArticles,
  // Content tier classification (5-tier taxonomy)
  classifyContentTier,
  detectTruncationSignals,
  stripFooterContent,
  getScrapingPriority,
  countWords,
  // Phase 1: Post-scrape validation functions
  extractByline,
  matchesCritic,
  computeContentFingerprint,
  // Phase 1D: Content-to-show verification
  verifyFullTextContent,
  // Venue aliases (for testing + reuse by other validators)
  getVenueAliasGroup,
  VENUE_ALIAS_GROUPS,
  // Export individual detectors for testing/debugging
  detectAdBlocker,
  detectPaywall,
  detectLegalPage,
  detectErrorPage,
  detectStrongErrorPageAnywhere,
  detectStrongChromeDumpAnywhere,
  detectNewsletter,
  detectUrlOnly,
  detectNavigationJunk,
  detectWrongArticle,
  detectHorrorFilmContent,
  // Author extraction from HTML
  extractAuthorFromHtml,
  extractHighConfidenceAuthor,
  isValidAuthorName,
  cleanAuthorName,
  // Export constants for reference
  THEATER_KEYWORDS,
  CURRENT_BROADWAY_SHOWS,
  ARTICLE_BOUNDARY_PATTERNS,
  TRUNCATION_SIGNALS,
  // Pattern arrays — consumed by scripts/audit-regex-patterns.js FP gate
  AD_BLOCKER_PATTERNS,
  PAYWALL_PATTERNS,
  LEGAL_PAGE_PATTERNS,
  COOKIE_CONSENT_PATTERNS,
  ERROR_PAGE_PATTERNS,
  STRONG_ERROR_PAGE_PATTERNS,
  STRONG_CHROME_DUMP_PATTERNS,
  NEWSLETTER_PATTERNS,
  NAVIGATION_PATTERNS,
  WRONG_ARTICLE_PATTERNS,
  HORROR_FILM_PATTERNS,
  // Opinion language detection — used by content-verifier shouldDeferCvWrongShow
  hasOpinionLanguage,
};
