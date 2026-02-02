/**
 * Score Extractors - Extract original scores from review HTML/text
 *
 * Outlets with known score formats:
 * - TimeOut: Uses 3-5 stars (retired 1-2 stars), format "X out of 5 stars"
 * - EW (Entertainment Weekly): Letter grades A-F with +/- (e.g., "A", "B+", "C-")
 * - NYSR (New York Stage Review): Unicode stars ★★★☆☆
 * - NY Post: Sometimes letter grades or stars
 * - The Guardian: Star ratings /5
 * - Culture Sauce: Star ratings /5
 * - NY Daily News: Sometimes letter grades
 *
 * Score normalization:
 * - All scores normalized to 0-100 scale
 * - Return both originalScore (human-readable) and normalizedScore (0-100)
 *
 * IMPORTANT: Avoid false positives from CSS/JS code!
 * Only match patterns that clearly indicate a review rating.
 */

/**
 * Clean HTML of scripts, styles, and CSS to avoid false positives
 */
function cleanHtmlForScoring(html) {
  if (!html) return '';
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/style\s*=\s*"[^"]*"/gi, '')
    .replace(/style\s*=\s*'[^']*'/gi, '')
    .replace(/calc\s*\([^)]*\)/gi, '')  // Remove CSS calc()
    .replace(/padding[^;:]*[;:][^;]*/gi, '')  // Remove padding rules
    .replace(/margin[^;:]*[;:][^;]*/gi, '');  // Remove margin rules
}

// Letter grade to numeric conversion
const LETTER_GRADES = {
  'A+': 98, 'A': 95, 'A-': 92,
  'B+': 88, 'B': 85, 'B-': 82,
  'C+': 78, 'C': 75, 'C-': 72,
  'D+': 68, 'D': 65, 'D-': 62,
  'F': 50
};

// Star rating to numeric (out of 5)
function starsToNumeric(filled, total = 5) {
  return Math.round((filled / total) * 100);
}

/**
 * Extract score from TimeOut review HTML
 * Format: "X out of 5 stars" or star icons
 */
function extractTimeOutScore(html, text) {
  // Try JSON-LD structured data first
  const jsonLdMatch = html.match(/"ratingValue"\s*:\s*"?(\d+(?:\.\d+)?)"?/i);
  if (jsonLdMatch) {
    const rating = parseFloat(jsonLdMatch[1]);
    if (rating <= 5) {
      return {
        originalScore: `${rating}/5`,
        normalizedScore: starsToNumeric(rating, 5),
        source: 'json-ld'
      };
    }
  }

  // Try "X out of 5 stars" pattern
  const outOfMatch = html.match(/(\d+(?:\.\d+)?)\s*out of\s*5\s*stars?/i) ||
                     text.match(/(\d+(?:\.\d+)?)\s*out of\s*5\s*stars?/i);
  if (outOfMatch) {
    const rating = parseFloat(outOfMatch[1]);
    return {
      originalScore: `${rating}/5`,
      normalizedScore: starsToNumeric(rating, 5),
      source: 'text-pattern'
    };
  }

  // Try star rating icons in HTML
  const starIconMatch = html.match(/class="[^"]*star[^"]*"[^>]*>.*?(\d+)/i);
  if (starIconMatch) {
    const rating = parseInt(starIconMatch[1]);
    if (rating >= 1 && rating <= 5) {
      return {
        originalScore: `${rating}/5`,
        normalizedScore: starsToNumeric(rating, 5),
        source: 'star-icon'
      };
    }
  }

  return null;
}

/**
 * Extract score from Entertainment Weekly review
 * Format: Letter grades (A+, A, A-, B+, etc.)
 */
function extractEWScore(html, text) {
  // Look for grade pattern in various formats
  const patterns = [
    /(?:grade|rating)\s*:?\s*([A-F][+-]?)/i,
    /\bgrade\s*([A-F][+-]?)\b/i,
    /\b([A-F][+-]?)\s*(?:rating|grade)\b/i,
    // EW often has grade in a specific div
    /class="[^"]*grade[^"]*"[^>]*>\s*([A-F][+-]?)\s*</i,
    // Common pattern: "EW Grade: B+"
    /EW\s+Grade:?\s*([A-F][+-]?)/i
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern) || text.match(pattern);
    if (match) {
      const grade = match[1].toUpperCase();
      if (LETTER_GRADES[grade] !== undefined) {
        return {
          originalScore: grade,
          normalizedScore: LETTER_GRADES[grade],
          source: 'letter-grade'
        };
      }
    }
  }

  return null;
}

/**
 * Extract score from NYSR (New York Stage Review)
 * Format: Unicode stars ★★★☆☆
 */
function extractNYSRScore(html, text) {
  // Count filled stars (★) vs empty stars (☆)
  const starMatch = text.match(/([★☆]{1,5})/) || html.match(/([★☆]{1,5})/);
  if (starMatch) {
    const stars = starMatch[1];
    const filled = (stars.match(/★/g) || []).length;
    const total = stars.length;
    if (total >= 1 && total <= 5) {
      return {
        originalScore: `${filled}/${total} stars`,
        normalizedScore: starsToNumeric(filled, total),
        source: 'unicode-stars'
      };
    }
  }

  // Alternative format: "3/5" or "4 stars"
  const numericMatch = text.match(/(\d)\s*(?:\/\s*5|stars?(?:\s*out\s*of\s*5)?)/i);
  if (numericMatch) {
    const rating = parseInt(numericMatch[1]);
    if (rating >= 1 && rating <= 5) {
      return {
        originalScore: `${rating}/5 stars`,
        normalizedScore: starsToNumeric(rating, 5),
        source: 'numeric-stars'
      };
    }
  }

  return null;
}

/**
 * Extract score from Guardian review
 * Format: Star ratings, often in structured data or visual stars
 */
function extractGuardianScore(html, text) {
  // Try JSON-LD
  const jsonLdMatch = html.match(/"ratingValue"\s*:\s*"?(\d+)"?/);
  if (jsonLdMatch) {
    const rating = parseInt(jsonLdMatch[1]);
    if (rating >= 1 && rating <= 5) {
      return {
        originalScore: `${rating}/5 stars`,
        normalizedScore: starsToNumeric(rating, 5),
        source: 'json-ld'
      };
    }
  }

  // Guardian uses SVG stars or star rating class
  const starClassMatch = html.match(/rating-(\d)/i) ||
                         html.match(/stars-(\d)/i);
  if (starClassMatch) {
    const rating = parseInt(starClassMatch[1]);
    if (rating >= 1 && rating <= 5) {
      return {
        originalScore: `${rating}/5 stars`,
        normalizedScore: starsToNumeric(rating, 5),
        source: 'star-class'
      };
    }
  }

  return null;
}

/**
 * Extract score from NY Post review
 * Format: Sometimes letter grades, sometimes stars
 * NOTE: NY Post doesn't consistently publish explicit grades, so we need
 * to be careful to only extract grades with clear context to avoid false positives.
 */
function extractNYPostScore(html, text) {
  // Only extract letter grade if there's clear grade context
  // Patterns like "Grade: A" or "rating: B+" or at the very start/end
  const gradePatterns = [
    /(?:grade|rating)\s*:?\s*([A-F][+-]?)\b/i,
    /\bgrade\s+([A-F][+-]?)\b/i,
    /\b([A-F][+-]?)\s+(?:grade|rating)\b/i,
    // At very beginning of text (like a header)
    /^([A-F][+-]?)\s*$/m
  ];

  for (const pattern of gradePatterns) {
    const match = text.match(pattern);
    if (match && LETTER_GRADES[match[1].toUpperCase()]) {
      return {
        originalScore: match[1].toUpperCase(),
        normalizedScore: LETTER_GRADES[match[1].toUpperCase()],
        source: 'letter-grade'
      };
    }
  }

  // Try star rating with clear context
  const starMatch = text.match(/(\d)\s*stars?\s*(?:out\s*of\s*5)?/i);
  if (starMatch) {
    const rating = parseInt(starMatch[1]);
    if (rating >= 1 && rating <= 5) {
      return {
        originalScore: `${rating} stars`,
        normalizedScore: starsToNumeric(rating, 5),
        source: 'numeric-stars'
      };
    }
  }

  return null;
}

/**
 * Extract score from Culture Sauce review
 * Format: Star ratings like "4/5"
 */
function extractCultureSauceScore(html, text) {
  const match = text.match(/(\d(?:\.\d)?)\s*\/\s*5/);
  if (match) {
    const rating = parseFloat(match[1]);
    return {
      originalScore: `${rating}/5`,
      normalizedScore: starsToNumeric(rating, 5),
      source: 'numeric-stars'
    };
  }
  return null;
}

/**
 * Generic star rating extractor for any outlet
 * Handles common patterns: "X/5", "X stars", "X out of 5"
 */
function extractGenericStarRating(html, text) {
  const patterns = [
    // "4/5" or "4.5/5"
    /(\d(?:\.\d)?)\s*\/\s*5/,
    // "4 stars" or "4.5 stars"
    /(\d(?:\.\d)?)\s*stars?(?:\s*(?:out\s+of|\/)\s*5)?/i,
    // "4 out of 5"
    /(\d(?:\.\d)?)\s*out\s*of\s*5/i,
    // Unicode stars
    /([★☆]{3,5})/
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern) || html.match(pattern);
    if (match) {
      if (match[1].includes('★') || match[1].includes('☆')) {
        // Unicode stars
        const filled = (match[1].match(/★/g) || []).length;
        const total = match[1].length;
        return {
          originalScore: `${filled}/${total} stars`,
          normalizedScore: starsToNumeric(filled, total),
          source: 'unicode-stars'
        };
      } else {
        const rating = parseFloat(match[1]);
        if (rating >= 0 && rating <= 5) {
          return {
            originalScore: `${rating}/5`,
            normalizedScore: starsToNumeric(rating, 5),
            source: 'numeric-stars'
          };
        }
      }
    }
  }

  return null;
}

/**
 * Generic letter grade extractor
 * Handles patterns: "Grade: B+", "B+", etc.
 */
function extractGenericLetterGrade(html, text) {
  // Only look for letter grades with clear context
  const patterns = [
    /(?:grade|rating)\s*:?\s*([A-F][+-]?)\b/i,
    /\bgrade\s+([A-F][+-]?)\b/i,
    /\b([A-F][+-]?)\s+(?:grade|rating)\b/i
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern) || html.match(pattern);
    if (match) {
      const grade = match[1].toUpperCase();
      if (LETTER_GRADES[grade] !== undefined) {
        return {
          originalScore: grade,
          normalizedScore: LETTER_GRADES[grade],
          source: 'letter-grade'
        };
      }
    }
  }

  return null;
}

/**
 * Return special marker for outlets that DON'T publish explicit scores
 * This prevents generic extractors from finding false positives
 */
function noScoreExtractor() {
  return { __skipGeneric: true };
}

// Map outlet IDs to their extractors
const OUTLET_EXTRACTORS = {
  // Outlets WITH explicit score formats
  'timeout': extractTimeOutScore,
  'time-out': extractTimeOutScore,
  'time-out-new-york': extractTimeOutScore,
  'timeoutny': extractTimeOutScore,
  'ew': extractEWScore,
  'entertainment-weekly': extractEWScore,
  'nysr': extractNYSRScore,
  'ny-stage-review': extractNYSRScore,
  'new-york-stage-review': extractNYSRScore,
  'nystagereview': extractNYSRScore,
  'guardian': extractGuardianScore,
  'the-guardian': extractGuardianScore,
  'nypost': extractNYPostScore,
  'ny-post': extractNYPostScore,
  'new-york-post': extractNYPostScore,
  'culturesauce': extractCultureSauceScore,
  'culture-sauce': extractCultureSauceScore,
  'nydailynews': extractGenericLetterGrade,
  'ny-daily-news': extractGenericLetterGrade,
  'nydn': extractGenericLetterGrade,

  // Outlets WITHOUT explicit scores - return null to prevent false positives
  'variety': noScoreExtractor,
  'deadline': noScoreExtractor,
  'hollywood-reporter': noScoreExtractor,
  'thr': noScoreExtractor,
  'nytimes': noScoreExtractor,  // NYT uses Critics' Pick designation, not scores
  'nyt': noScoreExtractor,
  'vulture': noScoreExtractor,
  'wsj': noScoreExtractor,
  'wapo': noScoreExtractor,
  'washpost': noScoreExtractor,
  'washington-post': noScoreExtractor,
  'theatermania': noScoreExtractor,  // Uses "Must See" designation, not scores
  'dailybeast': noScoreExtractor,
  'daily-beast': noScoreExtractor,
  'broadwaynews': noScoreExtractor,
  'broadway-news': noScoreExtractor,
  'observer': noScoreExtractor,
  'thewrap': noScoreExtractor,
  'the-wrap': noScoreExtractor,
};

/**
 * Main extraction function - tries outlet-specific extractor first,
 * then falls back to generic extractors
 *
 * @param {string} html - Raw HTML of the review page
 * @param {string} text - Extracted text content
 * @param {string} outletId - Normalized outlet ID
 * @returns {object|null} - { originalScore, normalizedScore, source } or null
 */
function extractScore(html, text, outletId) {
  html = html || '';
  text = text || '';
  outletId = (outletId || '').toLowerCase();

  // Clean HTML to avoid CSS/JS false positives
  const cleanedHtml = cleanHtmlForScoring(html);

  // Try outlet-specific extractor first (use cleaned HTML)
  if (OUTLET_EXTRACTORS[outletId]) {
    const result = OUTLET_EXTRACTORS[outletId](cleanedHtml, text);
    // Check for __skipGeneric marker (outlet explicitly doesn't have scores)
    if (result && result.__skipGeneric) {
      return null; // Don't use generic extractors for this outlet
    }
    if (result) {
      return { ...result, outlet: outletId };
    }
  }

  // Generic extractors: ONLY use text (not HTML) to avoid CSS false positives
  // Only run these for outlets NOT in the explicit list
  if (!OUTLET_EXTRACTORS[outletId]) {
    // Try generic star rating - TEXT ONLY
    const starResult = extractGenericStarRating('', text);
    if (starResult) {
      return { ...starResult, outlet: outletId };
    }

    // Try generic letter grade - TEXT ONLY
    const gradeResult = extractGenericLetterGrade('', text);
    if (gradeResult) {
      return { ...gradeResult, outlet: outletId };
    }
  }

  return null;
}

/**
 * Extract NYT Critics' Pick designation
 * ONLY check HTML for structural indicators — never search review text,
 * because phrases like "critics pick up on" cause false positives.
 */
function extractNYTCriticsPick(html, _text) {
  if (!html) return null;

  // Structured data: {"criticsPick": true} in JSON-LD
  if (/"criticsPick"\s*:\s*true/i.test(html)) return 'Critics_Pick';

  // NYT HTML markup: the Critics' Pick badge has specific class/element patterns
  if (/class="[^"]*critics?-?pick[^"]*"/i.test(html)) return 'Critics_Pick';
  if (/data-testid="[^"]*critics?-?pick[^"]*"/i.test(html)) return 'Critics_Pick';

  // The actual badge text as a standalone label (not in a sentence)
  // Requires apostrophe to avoid matching "critics pick up on..."
  if (/>\s*Critic['']s\s+Pick\s*</i.test(html)) return 'Critics_Pick';

  return null;
}

/**
 * Extract TheaterMania "Must See" designation
 * Only check HTML for structural indicators, not review text.
 */
function extractTheaterManiaMustSee(html, _text) {
  if (!html) return null;

  // CSS class pattern
  if (/class="[^"]*must-see[^"]*"/i.test(html)) return 'Must_See';

  // Badge/label markup (standalone, not in sentence)
  if (/>\s*Must\s+See\s*</i.test(html)) return 'Must_See';

  return null;
}

/**
 * Extract designation (Critics_Pick, Must_See, Recommended, etc.)
 * Designations are ONLY extracted from HTML structure, never from review text.
 * Review text contains false positives like "critics pick up on" or "recommended reading".
 */
function extractDesignation(html, text, outletId) {
  outletId = (outletId || '').toLowerCase();

  // NYT Critics' Pick — HTML only
  if (['nytimes', 'nyt', 'new-york-times'].includes(outletId)) {
    const pick = extractNYTCriticsPick(html, text);
    if (pick) return pick;
  }

  // TheaterMania Must See — HTML only
  if (['theatermania', 'theater-mania'].includes(outletId)) {
    const mustSee = extractTheaterManiaMustSee(html, text);
    if (mustSee) return mustSee;
  }

  // No generic "Recommended" extraction — too many false positives.
  // Recommended designations should come from aggregator data (DTLI/BWW thumbs),
  // not from matching the word "recommended" in review text.

  return null;
}

module.exports = {
  extractScore,
  extractDesignation,
  extractTimeOutScore,
  extractEWScore,
  extractNYSRScore,
  extractGuardianScore,
  extractNYPostScore,
  extractCultureSauceScore,
  extractGenericStarRating,
  extractGenericLetterGrade,
  extractNYTCriticsPick,
  extractTheaterManiaMustSee,
  LETTER_GRADES,
  starsToNumeric,
  OUTLET_EXTRACTORS
};
