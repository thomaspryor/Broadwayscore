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
  /ad\s*block(er)?/i,
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
  /subscriber(s)?(\s+only)?(\s+content)?/i,
  /premium\s+(content|article|access)/i,
  /create\s+(a\s+)?(free\s+)?account\s+to/i,
  /already\s+a\s+(member|subscriber)/i,
  /become\s+a\s+(member|subscriber)/i,
  /free\s+trial/i,
  /unlock\s+(this\s+)?(story|article|content)/i,
  /exclusive\s+(content|access)/i,
  /paywall/i,
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
 * Patterns that indicate 404/error pages
 * @type {RegExp[]}
 */
const ERROR_PAGE_PATTERNS = [
  /page\s+not\s+found/i,
  /404\s+(error|not\s+found)?/i,
  /error\s+404/i,
  /not\s+(been\s+)?found/i,
  /(this\s+)?(page|article|content)\s+(is\s+)?(no\s+longer|not)\s+(available|exists?)/i,
  /sorry[,.]?\s+(we\s+)?couldn'?t\s+find/i,
  /the\s+page\s+you('re|\s+are)\s+looking\s+for/i,
  /doesn'?t?\s+exist/i,
  /has\s+been\s+(removed|deleted|taken\s+down)/i,
  /content\s+(is\s+)?unavailable/i,
  /we\s+can'?t\s+find\s+(that|the)\s+(page|article)/i,
];

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
  /(footer|header|sidebar|menu|navigation)/i,
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
const WRONG_ARTICLE_PATTERNS = [
  /^insidious/im,  // Common scraping error - horror movie reviews
  /horror\s+(film|movie)/i,
  /box\s+office\s+(report|numbers|results)/i,
  /recipe|ingredients|cook(ing)?/i,
  /sports?\s+(news|scores|results)/i,
  /weather\s+(forecast|report)/i,
  /stock\s+(market|prices|trading)/i,
  /breaking\s+news/i,
  /election\s+(results|coverage)/i,
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
 * Used to detect 404/index pages and concatenated articles
 * @type {string[]}
 */
const CURRENT_BROADWAY_SHOWS = [
  // Currently running
  'purlie', 'ghosts', 'maybe happy ending', 'death becomes her',
  'stereophonic', 'cabaret', 'sunset boulevard', 'the outsiders',
  'hamilton', 'wicked', 'the lion king', 'chicago', 'phantom',
  'hadestown', 'moulin rouge', 'back to the future', 'merrily we roll along',
  'sweeney todd', 'the notebook', 'the great gatsby', 'water for elephants',
  'hell\'s kitchen', 'the who\'s tommy', 'suffs', 'the wiz', 'gypsy',
  'oh mary', 'appropriate', 'prayer for the french republic', 'mother play',
  'enemy of the people', 'mary jane', 'our town', 'mcneal', 'romeo juliet',
  'yellowjackets', 'queen versailles', 'once upon a mattress', 'left on tenth',
  // Recent/closed (for detecting concatenated articles)
  'into the woods', 'funny girl', 'six', 'beetlejuice', 'aladdin',
  'dear evan hansen', 'come from away', 'the music man', 'company',
  'a beautiful noise', 'some like it hot', 'kimberly akimbo', 'parade',
  'shucked', 'new york new york', 'camelot', 'lempicka', 'the notebook',
  'days of wine and roses', 'pictures from home', 'the outsiders',
  'norma desmond', 'nicole scherzinger',  // Key cast names that indicate different shows
];

/**
 * Patterns that indicate article boundaries (multiple articles concatenated)
 * @type {RegExp[]}
 */
const ARTICLE_BOUNDARY_PATTERNS = [
  /now playing at the [A-Z][a-z]+ Theatre/gi,
  /currently running at the [A-Z][a-z]+ Theatre/gi,
  /playing at the [A-Z][a-z]+ Theatre/gi,
  /at the (Belasco|St\. James|Winter Garden|Booth|Lyceum|Shubert|Imperial|Majestic|Broadhurst|Barrymore|Palace|Lunt-Fontanne|Gershwin|Marquis|Nederlander|Neil Simon|Rodgers|Schoenfeld|Brooks Atkinson|Circle in the Square|Helen Hayes|Jacobs|Eugene O'Neill|Longacre|Ambassador|Cort|Gerald Schoenfeld|Stephen Sondheim|Vivian Beaumont|August Wilson|Music Box|Lyric|Al Hirschfeld|American Airlines)/gi,
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

  // Extract the expected show's key words to exclude them
  const expectedWords = expectedShowId
    ? expectedShowId.replace(/-\d{4}$/, '').split('-').filter(w => w.length > 3)
    : [];

  // Find which shows are mentioned
  const foundShows = CURRENT_BROADWAY_SHOWS.filter(show => {
    // Skip if this is the expected show
    const showWords = show.split(/\s+/);
    const isExpectedShow = expectedWords.some(ew => showWords.some(sw => sw.includes(ew) || ew.includes(sw)));
    if (isExpectedShow) return false;

    return lower.includes(show);
  });

  // If 3+ different shows are mentioned, this is likely a 404/index page
  if (foundShows.length >= 3) {
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

  // If we have 2+ article boundary patterns, likely concatenated
  if (boundaryMatches.length >= 2) {
    // Sort by position
    boundaryMatches.sort((a, b) => a.index - b.index);
    // The first boundary after position 500 is likely where concatenation starts
    const firstBoundary = boundaryMatches.find(m => m.index > 500);
    if (firstBoundary) {
      return {
        detected: true,
        reason: `Multiple article boundaries detected (${boundaryMatches.length})`,
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
 * Check if text contains indicators of a horror/film review (common scraping mistake)
 * @param {string} text - Text to check
 * @returns {{ detected: boolean, reason: string | null }}
 */
function detectHorrorFilmContent(text) {
  const lower = text.toLowerCase();

  // Specific patterns that indicate horror/film content mixed into Broadway reviews
  const horrorFilmPatterns = [
    /insidious/i,
    /horror\s*(film|movie|sequel)/i,
    /terrifying\s+sequel/i,
    /haunted\s+(family|house|lambert)/i,
    /spirit\s+world/i,
    /scary\s+movies?/i,
    /horror\s+film/i,
  ];

  for (const pattern of horrorFilmPatterns) {
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

  // Check for ad blocker message
  const adBlocker = detectAdBlocker(text);
  if (adBlocker.detected) {
    return { isGarbage: true, reason: `Ad blocker message: "${adBlocker.match}"` };
  }

  // Check for paywall
  const paywall = detectPaywall(text);
  if (paywall.detected) {
    return { isGarbage: true, reason: `Paywall/subscription prompt: "${paywall.match}"` };
  }

  // Check for 404/error page
  const errorPage = detectErrorPage(text);
  if (errorPage.detected) {
    return { isGarbage: true, reason: `Error/404 page: "${errorPage.match}"` };
  }

  // Check for legal/privacy page
  const legalPage = detectLegalPage(text);
  if (legalPage.detected) {
    return { isGarbage: true, reason: `Legal/privacy page: "${legalPage.match}"` };
  }

  // Check for newsletter form
  const newsletter = detectNewsletter(text);
  if (newsletter.detected) {
    return { isGarbage: true, reason: `Newsletter form: "${newsletter.match}"` };
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
  const multiShowCheck = detectMultiShowContent(text, showId);
  if (multiShowCheck.detected) {
    return {
      quality: 'garbage',
      confidence: 'high',
      issues: [multiShowCheck.reason]
    };
  }

  // Check for concatenated articles (other reviews appended)
  const concatenatedCheck = detectConcatenatedArticles(text, showId);
  if (concatenatedCheck.detected) {
    return {
      quality: 'garbage',
      confidence: 'high',
      issues: [concatenatedCheck.reason],
      truncateAt: concatenatedCheck.truncateAt
    };
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
    /©\s*\d{4}/,
    /all\s+rights\s+reserved/i,
    /cookie\s+(policy|settings)/i,
    /advertise\s+with\s+us/i,
  ]
};

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

  // Check severe signals
  for (const pattern of TRUNCATION_SIGNALS.severe) {
    if (pattern.test(text)) {
      signals.push('paywall_or_login_prompt');
      severeCount++;
      break; // One severe is enough
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

  // Check if text ends with proper punctuation
  const trimmed = text.trim();
  if (trimmed.length > 100 && !/[.!?"'"")\]]$/.test(trimmed)) {
    signals.push('no_ending_punctuation');
    moderateCount++;
  }

  // Check for footer junk (indicates text went past review ending)
  const lastChunk = text.slice(-500);
  for (const pattern of TRUNCATION_SIGNALS.footer) {
    if (pattern.test(lastChunk)) {
      signals.push('has_footer_junk');
      break;
    }
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
  const fullText = review.fullText || '';
  const wordCount = countWords(fullText);
  const charCount = fullText.length;

  // Check for excerpts
  const hasExcerpt = !!(review.dtliExcerpt || review.bwwExcerpt || review.showScoreExcerpt);
  const longestExcerptLen = Math.max(
    (review.dtliExcerpt || '').length,
    (review.bwwExcerpt || '').length,
    (review.showScoreExcerpt || '').length
  );

  // T5: INVALID - Check first (garbage, wrong show, corrupted)
  if (review.textStatus === 'garbage_cleared' || review.wrongProduction) {
    return {
      contentTier: 'invalid',
      wordCount,
      truncationSignals: [],
      tierReason: review.textStatus === 'garbage_cleared' ? 'Marked as garbage' : 'Wrong production'
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
  const endsWithPunctuation = /[.!?"'"")\]]$/.test(trimmed);
  const endsWithUrl = /\.(com|org|net|co\.uk)\/?$/.test(trimmed);
  const hasProperEnding = endsWithPunctuation || endsWithUrl;

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
    case 'invalid':
      return { priority: -1, reason: 'Invalid - needs manual review or deletion' };
    case 'complete':
    default:
      return { priority: 0, reason: 'Complete - no action needed' };
  }
}

module.exports = {
  isGarbageContent,
  hasReviewContent,
  assessTextQuality,
  // New enhanced validation functions
  validateShowMentioned,
  detectMultiShowContent,
  detectConcatenatedArticles,
  // Content tier classification (5-tier taxonomy)
  classifyContentTier,
  detectTruncationSignals,
  getScrapingPriority,
  countWords,
  // Export individual detectors for testing/debugging
  detectAdBlocker,
  detectPaywall,
  detectLegalPage,
  detectErrorPage,
  detectNewsletter,
  detectUrlOnly,
  detectNavigationJunk,
  detectWrongArticle,
  detectHorrorFilmContent,
  // Export constants for reference
  THEATER_KEYWORDS,
  CURRENT_BROADWAY_SHOWS,
  ARTICLE_BOUNDARY_PATTERNS,
  TRUNCATION_SIGNALS,
};
