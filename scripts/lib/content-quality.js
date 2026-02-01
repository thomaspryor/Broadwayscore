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
 * Current Broadway shows for multi-show detection
 * Used to detect 404/index pages that list multiple shows
 * @type {string[]}
 */
const CURRENT_BROADWAY_SHOWS = [
  'purlie', 'ghosts', 'maybe happy ending', 'death becomes her',
  'stereophonic', 'cabaret', 'sunset boulevard', 'the outsiders',
  'hamilton', 'wicked', 'the lion king', 'chicago', 'phantom',
  'hadestown', 'moulin rouge', 'back to the future', 'merrily we roll along',
  'sweeney todd', 'the notebook', 'the great gatsby', 'water for elephants',
  'hell\'s kitchen', 'the who\'s tommy', 'suffs', 'the wiz', 'gypsy',
  'oh mary', 'appropriate', 'prayer for the french republic', 'mother play',
  'enemy of the people', 'mary jane', 'our town', 'mcneal', 'romeo juliet',
  'yellowjackets', 'queen versailles', 'once upon a mattress', 'left on tenth',
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

module.exports = {
  isGarbageContent,
  hasReviewContent,
  assessTextQuality,
  // New enhanced validation functions
  validateShowMentioned,
  detectMultiShowContent,
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
};
