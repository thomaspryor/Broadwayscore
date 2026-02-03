/**
 * Text Cleaning Module
 *
 * Centralized text cleaning for review data. Used by:
 * - gather-reviews.js (clean text before writing review files)
 * - collect-review-texts.js (clean scraped text before quality classification)
 * - rebuild-all-reviews.js (decode entities when building reviews.json)
 *
 * @module text-cleaning
 */

/**
 * Decode ALL HTML entities properly
 * Handles both numeric (&#8220;, &#x201C;) and named (&amp;, &rsquo;) entities.
 *
 * @param {string} text - Text with HTML entities
 * @returns {string} Text with entities decoded
 */
function decodeHtmlEntities(text) {
  if (!text) return text;
  return text
    // Numeric entities
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
    // Named entities - common ones
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&rsquo;|&lsquo;/g, "'")
    .replace(/&rdquo;|&ldquo;/g, '"')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '...')
    .replace(/&auml;/g, 'ä')
    .replace(/&ouml;/g, 'ö')
    .replace(/&uuml;/g, 'ü')
    .replace(/&apos;/g, "'")
    .replace(/&copy;/g, '©')
    .replace(/&reg;/g, '®')
    .replace(/&trade;/g, '™')
    .replace(/&euro;/g, '€')
    .replace(/&pound;/g, '£')
    .replace(/&iacute;/g, 'í')
    .replace(/&eacute;/g, 'é')
    .replace(/&oacute;/g, 'ó')
    .replace(/&aacute;/g, 'á')
    .replace(/&uacute;/g, 'ú')
    .replace(/&ntilde;/g, 'ñ')
    .replace(/&ccedil;/g, 'ç');
}

// Junk patterns to strip from end of reviews (newsletter promos, login prompts, site footers)
const TRAILING_JUNK_PATTERNS = [
  // TheaterMania newsletter promos
  /\s*Get the latest news, discounts and updates on theater and shows by signing up for TheaterMania.*$/is,
  /\s*TheaterMania&#039;s newsletter today!.*$/is,
  // BroadwayNews login prompts
  /\s*Already have an account\?\s*(Sign in|Log in).*$/is,
  // amNY "Read more" promos
  /\s*Read more:\s*[^\n]+$/i,
  // Vulture/NY Mag signup junk
  /\s*This email will be used to sign into all New York sites.*$/is,
  /\s*By submitting your email, you agree to our Terms and Privacy Policy.*$/is,
  /\s*Password must be at least 8 characters.*$/is,
  /\s*You're in!\s*As part of your account.*$/is,
  /\s*which you can opt out of anytime\.\s*$/i,
  /\s*occasional updates and offers from New York.*$/is,
  // Generic newsletter/promo junk
  /\s*Sign up for our newsletter.*$/is,
  /\s*Subscribe to our newsletter.*$/is,
  // Site footers
  /\s*About Us\s*\|\s*Editorial Guidelines\s*\|\s*Contact Us.*$/is,
  /\s*Share full article\d*Related Content.*$/is,
  /\s*Copyright\s*©?\s*\d{4}.*$/is,
  /\s*All rights reserved\.?\s*$/i,
  /\s*Excerpts and links to the content may be used.*$/is,
  // NYT bio junk
  /\s*is the chief theater critic for The Times\..*$/is,
  /\s*is a theater critic for The Times\..*$/is,

  // === Outlet-specific patterns (added Feb 2026) ===

  // EW: image tags, srcsets, "Related Articles/Content" blocks
  /\s*<img\b[^>]*>.*$/is,
  /\s*srcset\s*=\s*"[^"]*".*$/is,
  /\s*Related\s+(Articles?|Content)\s*[\n\r].*$/is,

  // BWW: paywall text
  /\s*Get Access To Every Broadway Story.*$/is,
  /\s*Unlock access to every one of our articles.*$/is,

  // Variety: interstitials
  /\s*Related Stories\s*[\n\r].*$/is,
  /\s*Popular on Variety\s*[\n\r].*$/is,
  /\s*More From Our Brands\s*[\n\r].*$/is,

  // BroadwayNews: site navigation junk (JS-rendered content)
  /\s*Broadway News\s*Menu\s*Close.*$/is,
  /\s*Broadway Briefing.*$/is,

  // The Times UK: paywall prefix
  /^We haven't been able to take payment.*?(?=\b[A-Z][a-z])/s,

  // === Time Out New York: newsletter subscription forms ===
  // Leading junk: repeated newsletter signup blocks (appear 3+ times at top of scraped pages)
  /^Thanks for subscribing!.*?inbox soon!\s*/is,
  /^The best of New York straight to your inbox\s*/i,
  /^By entering your email address you agree to our Terms of Use and Privacy Policy[^\n]*\n?\s*/i,
  /^Déjà vu! We already have this email\. Try another\?\s*/i,
  /^Our newsletter hand-delivers the best bits[^\n]*\n?\s*/i,
  /^Sign up to unlock our digital magazines[^\n]*\n?\s*/i,
  /^Sign up to our newsletter[^\n]*\n?\s*/i,
  /^An email you['']ll actually love\s*/i,
  /^Broadway review by [A-Z][a-z]+ [A-Z][a-z]+\s*/,
  // Time Out show metadata lines (ratings, categories, venue info)
  /^\d+ out of \d+ stars\s*/,
  /^Theater,?\s*Musicals?\s*$/m,
  /^Musicals?,?\s*Theater\s*$/m,
  /^Open run\s*/i,
  /^Recommended\s*/,
  // Trailing junk: signup form remnants that appear at end of scraped text
  /\s*(?:By entering your email address you agree to our|Thanks for subscribing).*$/is,
  // Trailing junk: social media follow links and event details
  /\s*Follow\s+\w[\w\s]+on\s+Twitter:.*$/is,
  /\s*TwitterPinterestEmail.*$/is,
  /\s*DetailsEvent website:.*$/is,
  // Trailing junk: footer navigation
  /\s*Been there, done that\? Think again, my friend\..*$/is,
  /\s*Discover Time Out original video.*$/is,
  /\s*Back to Top\s*Close\s*Get us in your inbox.*$/is,
  /\s*tiktokfacebooktwitteryoutube\s*About us.*$/is,
  /\s*An email you['']ll actually love.*$/is,

  // === Chicago Tribune: social sharing junk ===
  /^Things To Do Theater (?:Review|Critic's Notebook): /,
  /^Share this:\s*/,
  /^Click to share on (?:Facebook|Bluesky|X|print) \(Opens in new window\)\s*(?:Facebook|Bluesky|X|print)\s*/,

  // === IndieWire / Penske Media boilerplate ===
  /^IndieWire is a part of Penske Media Corporation\.\s*©\s*\d{4}[^.]*\.\s*All Rights Reserved\.\s*/i,

  // === Generic corporate boilerplate at start of text ===
  /^©\s*\d{4}\s+[A-Z][\w\s,]+(?:LLC|Inc|Corp|Ltd|Media|Entertainment)[^.]*\.\s*All Rights Reserved\.\s*/i,
];

/**
 * Strip trailing junk (newsletter promos, login prompts, site footers) from review text.
 * Also strips known leading junk (e.g., The Times UK paywall prefix).
 * Runs iteratively until no more patterns match.
 *
 * Guards (ported from text-quality.js) prevent catastrophic text destruction:
 *   - Back-half guard: only strip if match is in the last 40% of current text
 *   - Minimum-remaining guard: at least 200 chars (or 15% of original) must survive
 *
 * @param {string} text - Review text to clean
 * @returns {string} Cleaned text
 */
function stripTrailingJunk(text) {
  if (!text) return text;
  let cleaned = text;
  const originalLength = text.length;
  const minRemaining = Math.max(200, originalLength * 0.15);

  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of TRAILING_JUNK_PATTERNS) {
      // Leading patterns (^ anchored, e.g., Times UK paywall prefix) bypass position guards
      if (pattern.source.startsWith('^')) {
        const before = cleaned;
        cleaned = cleaned.replace(pattern, '').trim();
        if (cleaned !== before) changed = true;
        continue;
      }

      // Find where the pattern matches
      const match = cleaned.match(pattern);
      if (!match) continue;

      // Back-half guard: only strip if match is in the last 40% of current text.
      // Prevents keywords like "Copyright" in page headers from eating the review.
      if (match.index < cleaned.length * 0.6) continue;

      // Minimum-remaining guard: don't strip if too little text would remain.
      if (match.index < minRemaining) continue;

      const before = cleaned;
      cleaned = cleaned.replace(pattern, '').trim();
      if (cleaned !== before) changed = true;
    }
  }
  return cleaned;
}

/**
 * Strip leading navigation junk from scraped review text.
 * Many sites (TheWrap, BroadwayNews, NY Daily News, Chicago Tribune) include
 * "Skip to content" followed by site navigation menus, whitespace, and other
 * non-review content at the start of scraped text.
 *
 * Detects "Skip to content" / "Skip to main" at the start, then finds the first
 * substantial content line (>60 chars with sentence punctuation) and strips
 * everything before it.
 *
 * @param {string} text - Text that may start with navigation junk
 * @returns {string} Text with leading navigation stripped
 */
function stripLeadingNavigation(text) {
  if (!text) return text;

  // Check first 150 chars for "Skip to content/main" (may be preceded by event schedules etc.)
  const head = text.substring(0, 150);
  const skipMatch = head.match(/skip\s+to\s+(content|main)/i);
  if (!skipMatch) return text;

  // Cut everything before and including the "Skip to..." marker
  const markerEnd = text.indexOf(skipMatch[0]) + skipMatch[0].length;
  let cleaned = text.substring(markerEnd);

  // Also strip any trailing "...or skip to search" continuation
  cleaned = cleaned.replace(/^[,\s]*or\s+skip\s+to\s+search\.?\s*/i, '');

  // Find the first substantial line (>60 chars with sentence punctuation)
  const lines = cleaned.split('\n');
  let cutLine = -1;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.length > 60 && /[.!?,'"]/.test(trimmed)) {
      cutLine = i;
      break;
    }
  }

  // If substantial content starts after line 0, strip preceding nav junk lines
  if (cutLine > 0) {
    cleaned = lines.slice(cutLine).join('\n').trim();
  } else {
    cleaned = cleaned.trim();
  }

  // Always return stripped text — let downstream classifiers handle short content.
  // Returning the original nav-polluted text causes false "complete" classifications.
  if (cleaned.length > 0) {
    return cleaned;
  }

  return text;
}

/**
 * Strip NYSR-style cross-reference lines that contain star ratings from other critics.
 * e.g., "[Read Steven Suskin's ★★★★☆ review here.]"
 * These contaminate star extraction if not removed.
 */
function stripCrossReferences(text) {
  if (!text) return text;
  return text
    .replace(/\[Read\s+[^\]]*?★[^\]]*?review[^\]]*?\]/gi, '')
    .replace(/Read\s+\w[^.]*?★+☆*[^.]*?review here\.?/gi, '');
}

function cleanText(text) {
  if (!text) return text;

  let cleaned = text;

  // Step 1: Decode HTML entities
  cleaned = decodeHtmlEntities(cleaned);

  // Step 2: Strip control characters (keep \n, \r, \t)
  cleaned = cleaned.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  // Step 2b: Strip leading navigation junk ("Skip to content" + nav menus)
  cleaned = stripLeadingNavigation(cleaned);

  // Step 3: Strip cross-reference lines (before whitespace collapse so we don't leave gaps)
  cleaned = stripCrossReferences(cleaned);

  // Step 3b: Strip inline photo credit lines (e.g., "Show Name | Photograph: Courtesy Photographer")
  // Limit prefix to 100 chars and suffix to 150 chars to avoid eating entire single-line texts
  cleaned = cleaned.replace(/^.{0,100}\|\s*Photograph:.{0,150}$/gm, '');

  // Step 3c: Strip embedded JavaScript blocks (Chicago Tribune Trinity Audio player, etc.)
  cleaned = cleaned.replace(/function\s+\w+\s*\([^)]*\)\s*\{[^}]*(?:\{[^}]*\}[^}]*)*\}/g, '');

  // Step 3d: Strip JSON-LD blocks (schema.org structured data that leaks into scraped text)
  cleaned = cleaned.replace(/\{[^{}]*"@context"\s*:\s*"https?:\/\/schema\.org"[^{}]*\}/g, '');

  // Step 4: Collapse whitespace runs
  // Multiple spaces/tabs on same line → single space
  cleaned = cleaned.replace(/[^\S\n\r]+/g, ' ');
  // 3+ consecutive newlines → 2 newlines (preserve paragraph breaks)
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  // Step 5: Strip trailing/leading junk
  cleaned = stripTrailingJunk(cleaned);

  return cleaned.trim();
}

module.exports = {
  decodeHtmlEntities,
  stripLeadingNavigation,
  stripTrailingJunk,
  stripCrossReferences,
  cleanText,
  TRAILING_JUNK_PATTERNS,
};
