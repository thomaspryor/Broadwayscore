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
 * - NY Daily News: Does NOT publish letter grades (extractGenericLetterGrade mapped here was causing false positives)
 *
 * Score normalization:
 * - All scores normalized to 0-100 scale
 * - Return both originalScore (human-readable) and normalizedScore (0-100)
 *
 * IMPORTANT: Avoid false positives from CSS/JS code!
 * Only match patterns that clearly indicate a review rating.
 */

// Bump this when extractors are added or improved.
// recollect-for-scores.js stamps this on _noScoreOnHtml so stale
// "no score found" flags are retried after extractor changes.
const EXTRACTOR_VERSION = 6;  // v6: Guardian class-attribute anchoring (UUID/URL false positives), Radio Times <use>-anchored SVG matching

/**
 * Clean HTML of scripts, styles, and CSS to avoid false positives
 */
function cleanHtmlForScoring(html) {
  if (!html) return '';
  // Extract JSON-LD blocks before stripping scripts (they contain ratingValue)
  const jsonLdBlocks = [];
  const jsonLdRegex = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let jsonLdMatch;
  while ((jsonLdMatch = jsonLdRegex.exec(html)) !== null) {
    jsonLdBlocks.push(jsonLdMatch[1]);
  }
  const cleaned = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/style\s*=\s*"[^"]*"/gi, '')
    .replace(/style\s*=\s*'[^']*'/gi, '')
    .replace(/calc\s*\([^)]*\)/gi, '')
    .replace(/padding[^;:]*[;:][^;]*/gi, '')
    .replace(/margin[^;:]*[;:][^;]*/gi, '');
  // Re-inject JSON-LD so extractors can find ratingValue, bestRating, etc.
  if (jsonLdBlocks.length > 0) {
    return cleaned + '\n' + jsonLdBlocks.join('\n');
  }
  return cleaned;
}

// ===================================================
// CANONICAL SCORE MAPS — single source of truth for scripts.
// Must stay aligned with src/config/scoring.ts (LETTER_GRADE_MAP, BUCKET_SCORE_MAP, THUMB_SCORE_MAP).
// ===================================================

// Letter grade → 0-100
const LETTER_GRADES = {
  'A+': 95, 'A': 90, 'A-': 85,
  'B+': 80, 'B': 76, 'B-': 72,
  'C+': 67, 'C': 62, 'C-': 57,
  'D+': 42, 'D': 35, 'D-': 30,
  'F': 20
};

// Sentiment bucket → 0-100
const BUCKET_SCORES = {
  'Rave': 90, 'Positive': 82, 'Mixed': 65, 'Negative': 48, 'Pan': 30
};

// Aggregator thumb → 0-100
const THUMB_SCORES = {
  'Up': 80, 'Meh': 60, 'Flat': 60, 'Down': 35
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
  // Note: Reject ratings < 2 — TimeOut retired 1-2 star reviews, so "1/5" from JSON-LD
  // is typically scraped from a guide/info page, not an actual review.
  const jsonLdMatch = html.match(/"ratingValue"\s*:\s*"?(\d+(?:\.\d+)?)"?/i);
  if (jsonLdMatch) {
    const rating = parseFloat(jsonLdMatch[1]);
    if (rating >= 2 && rating <= 5) {
      return {
        originalScore: `${rating}/5`,
        normalizedScore: starsToNumeric(rating, 5),
        source: 'json-ld'
      };
    }
  }

  // TimeOut uses SVG stars: filled SVGs before _unfilledRating_ div, unfilled inside it
  const ratingStarsIdx = html.indexOf('_ratingStars_');
  if (ratingStarsIdx > -1) {
    const unfilledIdx = html.indexOf('_unfilledRating_', ratingStarsIdx);
    if (unfilledIdx > -1) {
      const filledSection = html.slice(ratingStarsIdx, unfilledIdx);
      const filledCount = (filledSection.match(/<svg /g) || []).length;
      if (filledCount >= 1 && filledCount <= 5) {
        return {
          originalScore: `${filledCount}/5`,
          normalizedScore: starsToNumeric(filledCount, 5),
          source: 'timeout-svg-stars'
        };
      }
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

  return null;
}

/**
 * Extract score from BroadwayWorld review
 * Format: Star image filename (e.g., "5stars.png", "4stars.png")
 * BWW uses cloudimages2.broadwayworld.com/Nstars.png images
 */
function extractBWWScore(html, text) {
  if (!html) return null;
  // Match star image: "5stars.png", "4stars.png", etc.
  // The image src contains "Nstars.png" where N is 1-5
  // Also check data-src/data-lazy-src for lazy-loaded images
  const match = html.match(/(?:(?:data-(?:lazy-)?)?src(?:set)?)=["'][^"']*?(\d)stars?\.png/i);
  if (match) {
    const stars = parseInt(match[1]);
    if (stars >= 1 && stars <= 5) {
      return {
        originalScore: `${stars}/5`,
        normalizedScore: starsToNumeric(stars, 5),
        source: 'bww-star-image',
      };
    }
  }
  // Also check for half-star images (e.g., "4halfstars.png" or "4.5stars.png")
  const halfMatch = html.match(/(?:(?:data-(?:lazy-)?)?src(?:set)?)=["'][^"']*?(\d)(?:half|\.5)stars?\.png/i);
  if (halfMatch) {
    const stars = parseInt(halfMatch[1]) + 0.5;
    if (stars >= 0.5 && stars <= 5) {
      return {
        originalScore: `${stars}/5`,
        normalizedScore: starsToNumeric(stars, 5),
        source: 'bww-star-image',
      };
    }
  }
  return null;
}

/**
 * Extract score from London Box Office review
 * Format: CSS class "bstarsN" where N is the star count (1-5)
 * Pattern: <span class="bstars"><span class="bstars4"></span></span>
 */
function extractLBOScore(html, text) {
  if (!html) return null;
  // The FIRST bstarsN element is the review's rating (second may be a different review)
  const match = html.match(/class="bstars(\d)"/);
  if (match) {
    const stars = parseInt(match[1]);
    if (stars >= 1 && stars <= 5) {
      return {
        originalScore: `${stars}/5`,
        normalizedScore: starsToNumeric(stars, 5),
        source: 'lbo-css-stars',
      };
    }
  }
  return null;
}

/**
 * Extract score from All That Dazzles review
 * Format: Star emoji (⭐️ or ⭐) in meta content/description
 * Pattern: content="⭐️⭐️⭐️⭐️⭐️ Review text..."
 */
function extractAllThatDazzlesScore(html, text) {
  if (!html) return null;
  // Look for star emoji in meta content (og:description or description)
  const metaMatch = html.match(/content="([⭐️🌟★]{1,}[^"]{0,200})"/);
  if (metaMatch) {
    // Count star emoji — handle both ⭐️ (star + variation selector) and ⭐
    const starStr = metaMatch[1];
    const starCount = (starStr.match(/⭐️|⭐|🌟|★/g) || []).length;
    if (starCount >= 1 && starCount <= 5) {
      return {
        originalScore: `${starCount}/5`,
        normalizedScore: starsToNumeric(starCount, 5),
        source: 'atd-emoji-stars',
      };
    }
  }
  // Also check article text for star emoji at the start
  if (text) {
    const textMatch = text.match(/^[⭐️🌟★\s]{2,}/);
    if (textMatch) {
      const starCount = (textMatch[0].match(/⭐️|⭐|🌟|★/g) || []).length;
      if (starCount >= 1 && starCount <= 5) {
        return {
          originalScore: `${starCount}/5`,
          normalizedScore: starsToNumeric(starCount, 5),
          source: 'atd-emoji-stars',
        };
      }
    }
  }
  // Check body HTML for emoji star clusters (ATD puts them in <span> tags)
  const bodyMatch = html.match(/((?:⭐️?|🌟|★){2,5})/);
  if (bodyMatch) {
    const starCount = (bodyMatch[1].match(/⭐️|⭐|🌟|★/g) || []).length;
    if (starCount >= 1 && starCount <= 5) {
      return {
        originalScore: `${starCount}/5`,
        normalizedScore: starsToNumeric(starCount, 5),
        source: 'atd-emoji-stars',
      };
    }
  }
  return null;
}

/**
 * Extract score from Theatre Weekly review
 * Format: Image filename (e.g., "New-5star-350x71.png")
 * Title attribute: "Five Star Review from Theatre Weekly"
 */
function extractTheatreWeeklyScore(html, text) {
  if (!html) return null;
  // Image filename: New-Nstar-
  const match = html.match(/(?:(?:data-(?:lazy-)?)?src(?:set)?)=["'][^"']*?New-(\d)star/i);
  if (match) {
    const stars = parseInt(match[1]);
    if (stars >= 1 && stars <= 5) {
      return {
        originalScore: `${stars}/5 stars`,
        normalizedScore: starsToNumeric(stars, 5),
        source: 'theatre-weekly-star-image',
      };
    }
  }
  // Fallback: title attribute "Five Star Review", "Four Star Review", etc.
  const wordMap = { one: 1, two: 2, three: 3, four: 4, five: 5 };
  const titleMatch = html.match(/title=["'](\w+)\s+Star\s+Review/i);
  if (titleMatch) {
    const stars = wordMap[titleMatch[1].toLowerCase()];
    if (stars) {
      return {
        originalScore: `${stars}/5 stars`,
        normalizedScore: starsToNumeric(stars, 5),
        source: 'theatre-weekly-star-image',
      };
    }
  }
  return null;
}

/**
 * Extract score from Radio Times review
 * Format: Page JSON has "starRatingValue":"N" or "ratingValue":"N"
 * Also has SVG sprites with #star-fill / #star-empty
 */
function extractRadioTimesScore(html, text) {
  if (!html) return null;
  // Page JSON data: "starRatingValue":"5" or "ratingValue":"5"
  const jsonMatch = html.match(/"starRatingValue"\s*:\s*"?(\d(?:\.\d)?)"?/);
  if (jsonMatch) {
    const stars = parseFloat(jsonMatch[1]);
    if (stars >= 1 && stars <= 5) {
      return {
        originalScore: `${stars}/5 stars`,
        normalizedScore: starsToNumeric(stars, 5),
        source: 'radiotimes-page-json',
      };
    }
  }
  // Fallback: count SVG <use> star-fill references (not bare #star-fill,
  // which could match CSS rules or inline SVG <defs> if sprites are inlined)
  const fills = (html.match(/<use[^>]+#star-fill/g) || []).length;
  const halfs = (html.match(/<use[^>]+#star-half/g) || []).length;
  if (fills > 0 || halfs > 0) {
    const total = fills + halfs * 0.5;
    if (total >= 1 && total <= 5) {
      return {
        originalScore: `${total}/5 stars`,
        normalizedScore: starsToNumeric(total, 5),
        source: 'radiotimes-svg-stars',
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
  // EW puts "Grade: B+" (or "Grade: B–" with em-dash) at the end of reviews.
  // Search text first (more reliable), then HTML. Handle em/en-dash as minus.
  const patterns = [
    // Highest confidence: "Grade: X" in review text
    /(?:grade|rating)\s*:?\s*([A-F][+\-–—]?)/i,
    /\bgrade\s*([A-F][+\-–—]?)\b/i,
    /\b([A-F][+\-–—]?)\s*(?:rating|grade)\b/i,
    // EW often has grade in a specific div
    /class="[^"]*grade[^"]*"[^>]*>\s*([A-F][+\-–—]?)\s*</i,
    // Common pattern: "EW Grade: B+"
    /EW\s+Grade:?\s*([A-F][+\-–—]?)/i
  ];

  for (const pattern of patterns) {
    // Search text first (grade at end of review), then HTML
    const match = text.match(pattern) || html.match(pattern);
    if (match) {
      // Normalize em-dash/en-dash to ASCII minus
      const grade = match[1].toUpperCase().replace(/[–—]/g, '-');
      if (LETTER_GRADES[grade] !== undefined) {
        // Reject bare "D" and "D-" — overwhelmingly false positives from page templates.
        // Distribution: D=58, D+=2, D-=1. D+ kept (specific enough to be real).
        if (grade === 'D' || grade === 'D-') continue;
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

  // Guardian uses SVG stars or star rating class.
  // Anchor to class= attribute to avoid matching UUIDs (ub-star-rating-1ae3...)
  // and URL slugs (all-stars-5). Strip <style> blocks first like NY Post fix.
  const htmlNoStyles = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  const starClassMatch = htmlNoStyles.match(/class="[^"]*\brating-(\d)\b[^"]*"/i) ||
                         htmlNoStyles.match(/class="[^"]*\bstars-(\d)\b[^"]*"/i);
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
  // NY Post uses CSS star widgets on newer articles (2019+).
  // rating__star--filled = full star, rating__star--half = half star, on a 4-star scale.
  // IMPORTANT: Count actual DOM elements, not CSS class definitions.
  // NY Post HTML contains CSS rules like `.rating__star--filled svg{fill:...}` — these are NOT stars.
  // Strip <style> blocks first, then match only actual elements with star classes.
  const htmlNoStyles = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  {
    const filled = (htmlNoStyles.match(/<[a-z][^>]*\bclass="[^"]*\brating__star--filled\b[^"]*"/gi) || []).length;
    const half = (htmlNoStyles.match(/<[a-z][^>]*\bclass="[^"]*\brating__star--half\b[^"]*"/gi) || []).length;
    if (filled > 0) {
      const rating = filled + (half * 0.5);
      if (rating >= 0.5 && rating <= 4) {
        return {
          originalScore: `${rating}/4 stars`,
          normalizedScore: starsToNumeric(rating, 4),
          source: 'css-stars'
        };
      }
    }
  }

  // Letter grade patterns: "Grade: A" or "rating: B+"
  const gradePatterns = [
    /(?:grade|rating)\s*:?\s*([A-F][+-]?)\b/i,
    /\bgrade\s+([A-F][+-]?)\b/i,
    /\b([A-F][+-]?)\s+(?:grade|rating)\b/i,
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

  // Star rating in text: "4 stars" or "3 stars out of 5"
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
 * Extract score from TheReviewsHub
 * Format: percentage rating in class="number rating" element (e.g., 90%)
 */
/**
 * Extract score from Afridiziak Theatre News
 * Format: star rating image filename (e.g., "4-0-star-rating.jpg")
 */
function extractAfridiziak(html, text) {
  const imgMatch = html.match(/(\d)-0-star-rating\.(?:jpg|png|webp)/i);
  if (imgMatch) {
    const rating = parseInt(imgMatch[1]);
    if (rating >= 1 && rating <= 5) {
      return {
        originalScore: `${rating}/5 stars`,
        normalizedScore: starsToNumeric(rating, 5),
        source: 'afridiziak-star-image'
      };
    }
  }
  return null;
}

function extractReviewsHubScore(html, text) {
  const pctMatch = html.match(/class="[^"]*number\s+rating[^"]*"[^>]*>[\s\S]*?(\d{2,3})\s*(?:<[^>]*>)*\s*%/i);
  if (pctMatch) {
    const pct = parseInt(pctMatch[1]);
    if (pct >= 10 && pct <= 100) {
      return {
        originalScore: `${pct}%`,
        normalizedScore: pct,
        source: 'reviewshub-percentage'
      };
    }
  }
  return null;
}

/**
 * Extract star rating from UK outlets that use /5 star systems.
 * Checks JSON-LD ratingValue, CSS star classes, and text patterns.
 * Used by: WhatsOnStage, The Stage, Telegraph, Evening Standard,
 *          The Independent, The Times, Financial Times, Daily Mail, The Arts Desk,
 *          Musical Theatre Review, London Theatre, All That Dazzles, etc.
 */
function extractUKStarRating(html, text) {
  // 1. Structured data: JSON-LD ("ratingValue": 5) or meta/itemprop ("ratingValue" content="5")
  const jsonLdMatch = html.match(/"ratingValue"\s*:\s*"?(\d+(?:\.\d+)?)"?/) ||
                      html.match(/"ratingValue"\s+content="(\d+(?:\.\d+)?)"/);
  if (jsonLdMatch) {
    const rating = parseFloat(jsonLdMatch[1]);
    if (rating >= 1 && rating <= 5) {
      return {
        originalScore: `${rating}/5 stars`,
        normalizedScore: starsToNumeric(rating, 5),
        source: 'json-ld'
      };
    }
  }

  // 2a. WhatsOnStage: yellow.png (filled) vs star-grey.png (empty) images
  if (html.includes('article-star-rating-container') || html.includes('whatsonstage.com')) {
    const yellow = (html.match(/yellow\.png/g) || []).length;
    const grey = (html.match(/star-grey\.png/g) || []).length;
    if (yellow > 0 && yellow + grey === 5) {
      return {
        originalScore: `${yellow}/5 stars`,
        normalizedScore: starsToNumeric(yellow, 5),
        source: 'wos-star-images'
      };
    }
  }

  // 2b. The Stage: stageStar.svg (filled) vs stageNoStar.svg (empty)
  // Extract from FIRST StarRating block only (page has related articles with their own ratings)
  if (html.includes('StarRating') || html.includes('stageStar.svg')) {
    const blockMatch = html.match(/StarRating[^"]*">((?:<img[^>]*>[\s]*){1,5})/);
    if (blockMatch) {
      const block = blockMatch[1];
      const filled = (block.match(/stageStar\.svg/g) || []).length;
      const empty = (block.match(/stageNoStar\.svg/g) || []).length;
      if (filled > 0 && filled + empty === 5) {
        return {
          originalScore: `${filled}/5 stars`,
          normalizedScore: starsToNumeric(filled, 5),
          source: 'stage-star-svg'
        };
      }
    }
  }

  // 2c. Telegraph: e-rating__text "N/5" within article-review__rating section
  // Must anchor to article-review__rating to avoid sidebar/related article ratings
  if (html.includes('e-rating') || html.includes('review-rating')) {
    // Best: find main review section by article-review__rating class, then read its rating text
    // Use data-test attribute which survives HTML cleaning better than class matching
    const mainReviewMatch = html.match(/article-review__rating[^>]*>[\s\S]*?data-test="review-rating-text"[^>]*>\s*(\d\.?\d?)\s*\/\s*5/);
    if (mainReviewMatch) {
      const rating = parseFloat(mainReviewMatch[1]);
      if (rating >= 1 && rating <= 5) {
        return {
          originalScore: `${rating}/5 stars`,
          normalizedScore: starsToNumeric(rating, 5),
          source: 'telegraph-svg-stars'
        };
      }
    }
    // Fallback: count active SVG stars in the review-rating section
    const ratingIdx = html.indexOf('article-review__rating');
    if (ratingIdx > -1) {
      const block = html.substring(ratingIdx, ratingIdx + 5000);
      const active = (block.match(/e-rating__star--active/g) || []).length;
      const half = (block.match(/e-rating__star--half/g) || []).length;
      const total = (block.match(/e-rating__star--large/g) || []).length;
      if (active > 0 && total === 5) {
        const rating = active + half * 0.5;
        return {
          originalScore: `${rating}/5 stars`,
          normalizedScore: starsToNumeric(rating, 5),
          source: 'telegraph-svg-stars'
        };
      }
    }
  }

  // 2d. Daily Mail: star rating in image filename (rating_showbiz_N.gif) — old format
  const dailyMailMatch = html.match(/rating_showbiz_(\d)\.gif/);
  if (dailyMailMatch) {
    const rating = parseInt(dailyMailMatch[1]);
    if (rating >= 1 && rating <= 5) {
      return {
        originalScore: `${rating}/5 stars`,
        normalizedScore: starsToNumeric(rating, 5),
        source: 'dailymail-rating-img'
      };
    }
  }

  // 2d2. Daily Mail: CSS star classes (new format) — mol-ratings-solid with rating-star selected
  if (html.includes('mol-ratings') || html.includes('rating-star')) {
    const ratingBlock = html.match(/mol-ratings[^"]*"[^>]*>[\s\S]*?<\/p>/i);
    if (ratingBlock) {
      const selected = (ratingBlock[0].match(/rating-star selected/g) || []).length;
      // Count individual star spans: "rating-star " (with space/quote, not "rating-stars")
      const total = (ratingBlock[0].match(/rating-star[\s"]/g) || []).length;
      if (selected > 0 && total === 5) {
        return {
          originalScore: `${selected}/5 stars`,
          normalizedScore: starsToNumeric(selected, 5),
          source: 'dailymail-css-stars'
        };
      }
    }
  }

  // 2e. Arts Desk: Drupal fivestar widget (editorRating block with <span class="on">N</span>)
  if (html.includes('editorRating') || html.includes('fivestar-widget')) {
    const fivestarMatch = html.match(/editorRating[\s\S]{0,500}?<span\s+class="on">(\d)<\/span>/);
    if (fivestarMatch) {
      const rating = parseInt(fivestarMatch[1]);
      if (rating >= 1 && rating <= 5) {
        return {
          originalScore: `${rating}/5 stars`,
          normalizedScore: starsToNumeric(rating, 5),
          source: 'fivestar-widget'
        };
      }
    }
  }

  // 3. CSS star rating classes (common in UK review sites)
  // Be more specific to avoid false positives from CSS/text
  const starClassMatch = html.match(/class="[^"]*(?:rating|review-score|star-count)[\s_-]*(\d)[^"]*"/i);
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

  // 4. Spelled-out star ratings: "Five stars!", "Three Stars</p>", "star rating: five stars"
  {
    const wordMap = { one: 1, two: 2, three: 3, four: 4, five: 5 };
    const wordStarPat = /\b(one|two|three|four|five)\s+stars?\s*(?:[!.,;:\)<]|$)/im;
    const wsMatch = html.match(wordStarPat) || text.match(wordStarPat);
    if (wsMatch) {
      const rating = wordMap[wsMatch[1].toLowerCase()];
      if (rating) {
        return {
          originalScore: `${rating}/5 stars`,
          normalizedScore: starsToNumeric(rating, 5),
          source: 'word-stars'
        };
      }
    }
  }

  // 5. Unicode stars in text or HTML (consecutive or space-separated)
  const unicodeMatch = text.match(/((?:[★☆]\s*){2,5})/) || html.match(/((?:[★☆]\s*){2,5})/);
  if (unicodeMatch) {
    const stars = unicodeMatch[1].replace(/\s/g, '');
    const filled = (stars.match(/★/g) || []).length;
    const empty = (stars.match(/☆/g) || []).length;
    // If both filled and empty are present, scale = filled + empty.
    // If only filled stars (no ☆), default to 5-star scale (UK standard).
    const total = (empty > 0) ? (filled + empty) : 5;
    if (filled >= 1 && filled <= 5) {
      return {
        originalScore: `${filled}/${total} stars`,
        normalizedScore: starsToNumeric(filled, total),
        source: 'unicode-stars'
      };
    }
  }

  // 6. Text patterns: "X/5", "X out of 5", "X stars"
  const textPatterns = [
    /(\d(?:\.\d)?)\s*\/\s*5/,
    /(\d(?:\.\d)?)\s*out\s*of\s*5/i,
    /(\d(?:\.\d)?)\s*stars?\b/i
  ];
  for (const pattern of textPatterns) {
    const match = text.match(pattern);
    if (match) {
      const rating = parseFloat(match[1]);
      if (rating >= 1 && rating <= 5) {
        return {
          originalScore: `${rating}/5 stars`,
          normalizedScore: starsToNumeric(rating, 5),
          source: 'text-pattern'
        };
      }
    }
  }

  return null;
}

/**
 * Extract letter grade (A+/A/A-/B+/.../F) from USA Today and similar outlets.
 * USA Today uses a numeric 0-100 scale internally, but some reviews show letter grades.
 */
function extractUSATodayScore(html, text) {
  // USA Today sometimes embeds the score in structured data
  // Check bestRating first to determine scale
  const bestRatingMatch = html.match(/"bestRating"\s*:\s*"?(\d+(?:\.\d+)?)"?/);
  const jsonLdMatch = html.match(/"ratingValue"\s*:\s*"?(\d+(?:\.\d+)?)"?/);
  if (jsonLdMatch) {
    const rating = parseFloat(jsonLdMatch[1]);
    const bestRating = bestRatingMatch ? parseFloat(bestRatingMatch[1]) : null;

    // If bestRating is available, use it to determine scale
    if (bestRating && bestRating <= 5 && rating >= 1 && rating <= bestRating) {
      return {
        originalScore: `${rating}/${bestRating} stars`,
        normalizedScore: starsToNumeric(rating, bestRating),
        source: 'json-ld'
      };
    }
    // If ratingValue <= 5, it's almost certainly a star rating (USA Today uses 4-star scale)
    if (rating >= 1 && rating <= 5 && !bestRating) {
      return {
        originalScore: `${rating}/4 stars`,
        normalizedScore: starsToNumeric(rating, 4),
        source: 'json-ld'
      };
    }
    // Only treat as 0-100 scale if value is clearly above star range
    if (rating > 5 && rating <= 100) {
      return {
        originalScore: `${rating}/100`,
        normalizedScore: Math.round(rating),
        source: 'json-ld'
      };
    }
  }

  // Try star ratings (USA Today sometimes uses stars)
  const starMatch = text.match(/(\d(?:\.\d)?)\s*(?:out\s+of\s+)?4\s*stars?/i);
  if (starMatch) {
    const rating = parseFloat(starMatch[1]);
    return {
      originalScore: `${rating}/4 stars`,
      normalizedScore: starsToNumeric(rating, 4),
      source: 'numeric-stars'
    };
  }

  return null;
}

/**
 * Generic star rating extractor for any outlet
 * Handles common patterns: "X/5", "X stars", "X out of 5"
 *
 * The X/5 pattern requires context validation to avoid false positives:
 * - Dates like "4/5/04" or "3/5/10" match the regex but aren't ratings
 * - Forum metadata like "Joined: 4/5/04" matches but isn't a rating
 * - Incidental fractions like "2/5 of the cast" aren't ratings
 *
 * Validation: X/5 must appear near rating-related context, near
 * the start/end of the text, or NOT be followed by date/prose patterns.
 */
function extractGenericStarRating(html, text) {
  // "X stars" and "X out of 5" are unambiguous — try them first
  const unambiguousPatterns = [
    // "4/5 stars" or "4.0/5.0 stars" — X/Y stars format, unambiguous with "stars" keyword
    /(\d(?:\.\d)?)\s*\/\s*\d(?:\.\d)?\s*stars?/i,
    // "4 stars" or "4.5 stars" — reject if preceded by "/" (part of "X/5 stars" already handled above)
    /(?<!\d\s*\/\s*)(\d(?:\.\d)?)\s*stars?(?:\s*(?:out\s+of|\/)\s*5)?/i,
    // "4 out of 5" — explicit wording, safe
    /(\d(?:\.\d)?)\s*out\s*of\s*5/i,
    // Unicode stars — visual, unambiguous
    /([★☆]{3,5})/
  ];

  for (const pattern of unambiguousPatterns) {
    const match = text.match(pattern) || html.match(pattern);
    if (match) {
      if (match[1].includes('★') || match[1].includes('☆')) {
        const filled = (match[1].match(/★/g) || []).length;
        const hasEmpty = match[1].includes('☆');
        // If both filled and empty stars shown, total = filled + empty
        // If only filled stars (no ☆), assume /5 scale (standard for theatre reviews)
        const total = hasEmpty ? match[1].length : 5;
        return {
          originalScore: `${filled}/${total} stars`,
          normalizedScore: starsToNumeric(filled, total),
          source: 'unicode-stars'
        };
      } else {
        const rating = parseFloat(match[1]);
        if (rating >= 1 && rating <= 5) {
          return {
            originalScore: `${rating}/5`,
            normalizedScore: starsToNumeric(rating, 5),
            source: 'numeric-stars'
          };
        }
      }
    }
  }

  // Spelled-out star ratings: "Five stars!", "Three Stars</p>"
  {
    const WORD_TO_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5 };
    const wordStarPat = /\b(one|two|three|four|five)\s+stars?\s*(?:[!.,;:\)<]|$)/im;
    const wsMatch = text.match(wordStarPat) || html.match(wordStarPat);
    if (wsMatch) {
      const rating = WORD_TO_NUM[wsMatch[1].toLowerCase()];
      if (rating) {
        return {
          originalScore: `${rating}/5 stars`,
          normalizedScore: starsToNumeric(rating, 5),
          source: 'word-stars'
        };
      }
    }
  }

  // "X/5" is ambiguous — could be a date (4/5/04), fraction (2/5 of the cast),
  // or forum metadata (Joined: 4/5/14). Apply targeted rejection rules.
  const xOf5Regex = /(\d(?:\.\d)?)\s*\/\s*5/g;
  let xOf5Match;
  while ((xOf5Match = xOf5Regex.exec(text)) !== null) {
    const rating = parseFloat(xOf5Match[1]);
    if (rating < 1 || rating > 5) continue;

    const pos = xOf5Match.index;
    const matchEnd = xOf5Match.index + xOf5Match[0].length;
    const afterMatch = text.slice(matchEnd, matchEnd + 20);
    const beforeMatch = text.slice(Math.max(0, pos - 40), pos);

    // REJECT: followed by /YY or /YYYY — it's a date like "4/5/04" or "3/5/2010"
    if (/^\s*\/\s*\d{2,4}\b/.test(afterMatch)) continue;

    // REJECT: followed by "of the/those/these/all/his/her/them" — prose fraction
    if (/^\s+of\s+(?:the|those|these|all|his|her|them|its)\b/i.test(afterMatch)) continue;

    // REJECT: preceded by forum/metadata patterns — "Joined: X/5" or "Member since X/5"
    if (/\b(?:joined|member\s+since|registered|posted|replied)\s*:?\s*\d{0,2}\s*\/?\s*$/i.test(beforeMatch)) continue;

    return {
      originalScore: `${rating}/5`,
      normalizedScore: starsToNumeric(rating, 5),
      source: 'numeric-stars'
    };
  }

  return null;
}

/**
 * Generic letter grade extractor
 * Handles patterns: "Grade: B+", "B+", etc.
 */
function extractGenericLetterGrade(html, text) {
  // Only look for letter grades with clear context
  // NOTE: Pattern 1 uses \b before the alternation to avoid matching "rating" as a
  // substring inside words like "celebrating", "operating", "frustrating".
  const patterns = [
    /\b(?:grade|rating)\s*:?\s*([A-F][+-]?)\b/i,
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
 * One Minute Critic (1minutecritic.com) - star ratings as "X out of 5 stars"
 * Also appears as img alt text "1 minute critic N-star rating"
 */
function extractOneMinuteCriticScore(html, text) {
  // 1. Alt text in star rating images (most reliable when HTML available)
  const altMatch = html.match(/1\s*minute\s*critic\s*(\d(?:\.\d)?)\s*-?\s*star/i);
  if (altMatch) {
    const rating = parseFloat(altMatch[1]);
    if (rating >= 1 && rating <= 5) {
      return { originalScore: `${rating}/5`, normalizedScore: starsToNumeric(rating, 5), source: 'omc-alt-text' };
    }
  }
  // 2. Text pattern: "N out of 5 stars" (appears at end of review)
  const textMatch = text.match(/(\d(?:\.\d)?)\s*out\s*of\s*5\s*stars?/i)
                 || html.match(/(\d(?:\.\d)?)\s*out\s*of\s*5\s*stars?/i);
  if (textMatch) {
    const rating = parseFloat(textMatch[1]);
    if (rating >= 1 && rating <= 5) {
      return { originalScore: `${rating}/5`, normalizedScore: starsToNumeric(rating, 5), source: 'omc-star-rating' };
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
  'broadwayworld': extractBWWScore,
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
  'nydailynews': noScoreExtractor,   // NYDN does not publish letter grades; extractGenericLetterGrade produced false positives
  'ny-daily-news': noScoreExtractor,
  'nydn': noScoreExtractor,

  // USA Today
  'usatoday': extractUSATodayScore,
  'usa-today': extractUSATodayScore,

  // UK outlets with star rating systems (/5 stars)
  'whatsonstage': extractUKStarRating,
  'whats-on-stage': extractUKStarRating,
  'thestage': extractUKStarRating,
  'the-stage': extractUKStarRating,
  'the-stage-uk': extractUKStarRating,
  'stage-uk': extractUKStarRating,
  'telegraph': extractUKStarRating,
  'the-telegraph': extractUKStarRating,
  'the-telegraph-uk': extractUKStarRating,
  'evening-standard': extractUKStarRating,
  'standard': extractUKStarRating,
  'the-independent': extractUKStarRating,
  'the-independent-uk': extractUKStarRating,
  'independent': extractUKStarRating,
  'the-times': extractUKStarRating,
  'the-times-uk': extractUKStarRating,
  'times-uk': extractUKStarRating,
  'the-times-clive-davis': extractUKStarRating,
  'financial-times': extractUKStarRating,
  'financial-times-uk': extractUKStarRating,
  'financialtimes': extractUKStarRating,
  'daily-mail': extractUKStarRating,
  'dailymail': extractUKStarRating,
  'the-arts-desk': extractUKStarRating,
  'artsdesk': extractUKStarRating,
  'musical-theatre-review': extractUKStarRating,
  'london-theatre': extractUKStarRating,
  'all-that-dazzles-uk': extractAllThatDazzlesScore,
  'all-that-dazzles': extractAllThatDazzlesScore,
  'london-box-office': extractLBOScore,
  'lbo': extractLBOScore,
  'everything-theatre': extractUKStarRating,
  'everything-theatre-uk': extractUKStarRating,
  'theatre-weekly': extractTheatreWeeklyScore,
  'theatre-bee-uk': extractUKStarRating,
  'radio-times': extractRadioTimesScore,
  'radiotimes': extractRadioTimesScore,
  'timeout-london': extractTimeOutScore,
  'i-newspaper': extractUKStarRating,
  'i-paper': extractUKStarRating,
  'the-express': extractUKStarRating,
  'express': extractUKStarRating,
  'cityam': extractUKStarRating,
  'the-recs': extractUKStarRating,
  'thereviewshub': extractReviewsHubScore,
  'the-reviews-hub': extractReviewsHubScore,
  'afridiziak-theatre-news': extractAfridiziak,
  'afridiziak': extractAfridiziak,
  'lost-in-theatreland': extractUKStarRating,
  'digital-journal': extractUKStarRating,
  'rollingstone': noScoreExtractor,    // RS theater reviews don't have star ratings
  'rolling-stone': noScoreExtractor,
  'theater-life': extractUKStarRating,
  'jks-theatre-scene': extractGenericLetterGrade,

  // One Minute Critic — star ratings ("X out of 5 stars")
  'one-minute-critic': extractOneMinuteCriticScore,
  '1-minute-critic': extractOneMinuteCriticScore,
  'oneminutecritic': extractOneMinuteCriticScore,
  '1minutecritic': extractOneMinuteCriticScore,

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
  'theater-news-online': noScoreExtractor,  // Site-wide 4.6/5, not per-review ratings
  'theatre-news-online': noScoreExtractor,  // Variant spelling
  'front-row-center': noScoreExtractor,     // Unreliable score extraction
  'nytg': noScoreExtractor,                 // NYTG hacked/replaced with jewelry spam; "D" is diamond color grade
  'new-york-theatre-guide': noScoreExtractor,
  'newyorker': noScoreExtractor,            // New Yorker doesn't publish letter grades
  'new-yorker': noScoreExtractor,
  'nbcny': noScoreExtractor,               // Extracted "D" from page template, not a rating
  'wnbc': noScoreExtractor,
  'new-jersey-newsroom': noScoreExtractor,  // Extracted "D" from page template
  'new-jersey-news-room': noScoreExtractor,
  'cititour': noScoreExtractor,             // 0/5 from empty star widget
  'slantmagazine': noScoreExtractor,        // Theater reviews have no star ratings; film uses stars but theater doesn't
  'slant-magazine': noScoreExtractor,
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

  // Try outlet-specific extractor first
  // Some outlets (Telegraph) have rating elements that cleanHtmlForScoring corrupts,
  // so try raw HTML first, then cleaned HTML as fallback
  if (OUTLET_EXTRACTORS[outletId]) {
    const result = OUTLET_EXTRACTORS[outletId](html, text) || OUTLET_EXTRACTORS[outletId](cleanedHtml, text);
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
    // Extract title/h1 text from HTML — many niche outlets put star ratings there
    // Title text is safe from CSS/JS false positives
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    const h1Match = html.match(/<h1[^>]*>([^<]*)<\/h1>/i);
    const titleText = [titleMatch?.[1], h1Match?.[1], text].filter(Boolean).join(' ');

    // Try generic star rating - cleaned HTML + augmented text
    // cleanedHtml is safe (script/style removed) for word-star and unicode-star patterns
    const starResult = extractGenericStarRating(cleanedHtml, titleText);
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
function extractNYTCriticsPick(html, text) {
  // Structured data: {"criticsPick": true} in JSON-LD
  if (html && /"criticsPick"\s*:\s*true/i.test(html)) return 'Critics_Pick';

  // NYT HTML markup: the Critics' Pick badge has specific class/element patterns
  if (html && /class="[^"]*critics?-?pick[^"]*"/i.test(html)) return 'Critics_Pick';
  if (html && /data-testid="[^"]*critics?-?pick[^"]*"/i.test(html)) return 'Critics_Pick';

  // The actual badge text as a standalone label (not in a sentence)
  // Requires apostrophe to avoid matching "critics pick up on..."
  if (html && />\s*Critic['']s\s+Pick\s*</i.test(html)) return 'Critics_Pick';

  // Fallback: check text content (BWW roundup excerpts, review body)
  // Matches "Critic's Pick" as a standalone designation phrase
  if (text && /\bCritic[''\u2019]s\s+Pick\b/i.test(text)) return 'Critics_Pick';

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

// ===================================================
// SCORE-TO-BUCKET/THUMB CONVERTERS — canonical thresholds.
// Import these instead of hardcoding boundary values.
// ===================================================

function scoreToBucket(score) {
  if (score >= 83) return 'Rave';
  if (score >= 70) return 'Positive';
  if (score >= 55) return 'Mixed';
  if (score >= 35) return 'Negative';
  return 'Pan';
}

function scoreToThumb(score) {
  if (score >= 70) return 'Up';
  if (score >= 55) return 'Flat';
  return 'Down';
}

// Outlets that use outlet-verified originalScore sources (not ShowScore aggregator data).
// Used by getBestScore() to decide whether to trust originalScore at P0.5 vs P3b.
const OUTLET_VERIFIED_SOURCES = new Set([
  'json-ld', 'meta-itemprop', 'guardian-api', 'guardian-json-ld', 'guardian-svg-stars',
  'wos-star-images', 'stage-star-svg',
  'telegraph-svg', 'telegraph-svg-stars', 'dailymail-rating-img', 'dailymail-css-stars', 'fivestar-widget',
  'star-class', 'unicode-stars', 'numeric-stars', 'original-star-rating',
  'timeout-star-widget', 'timeout-svg-stars',
  'lbo-star-rating', 'express-star-count', 'standard-star-count', 'dailymail-star-count',
  'text-pattern-verified', 'bww-star-image',
  'theatre-weekly-star-image', 'radiotimes-page-json', 'radiotimes-svg-stars',
  'lbo-css-stars', 'atd-emoji-stars',
  'text-pattern', 'css-stars', 'word-stars', 'star-rating',
  'reviewshub-percentage', 'explicit-rating', 'afridiziak-star-image',
]);

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
  extractUKStarRating,
  extractUSATodayScore,
  extractBWWScore,
  extractTheatreWeeklyScore,
  extractRadioTimesScore,
  extractLBOScore,
  extractAllThatDazzlesScore,
  extractNYTCriticsPick,
  extractTheaterManiaMustSee,
  LETTER_GRADES,
  BUCKET_SCORES,
  THUMB_SCORES,
  starsToNumeric,
  scoreToBucket,
  scoreToThumb,
  OUTLET_VERIFIED_SOURCES,
  OUTLET_EXTRACTORS,
  EXTRACTOR_VERSION
};
