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
];

/**
 * Strip trailing junk (newsletter promos, login prompts, site footers) from review text.
 * Also strips known leading junk (e.g., The Times UK paywall prefix).
 * Runs iteratively until no more patterns match.
 *
 * @param {string} text - Review text to clean
 * @returns {string} Cleaned text
 */
function stripTrailingJunk(text) {
  if (!text) return text;
  let cleaned = text;
  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of TRAILING_JUNK_PATTERNS) {
      const before = cleaned;
      cleaned = cleaned.replace(pattern, '').trim();
      if (cleaned !== before) changed = true;
    }
  }
  return cleaned;
}

/**
 * Master text cleaning function. Applies all cleaning steps in order:
 * 1. Decode HTML entities
 * 2. Strip control characters (except newlines/tabs)
 * 3. Collapse whitespace runs (multiple spaces → single, 3+ newlines → 2)
 * 4. Strip trailing junk patterns
 *
 * @param {string} text - Raw text to clean
 * @returns {string} Fully cleaned text
 */
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

  // Step 3: Strip cross-reference lines (before whitespace collapse so we don't leave gaps)
  cleaned = stripCrossReferences(cleaned);

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
  stripTrailingJunk,
  stripCrossReferences,
  cleanText,
  TRAILING_JUNK_PATTERNS,
};
