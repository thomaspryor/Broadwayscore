/**
 * Synopsis validation — shared between auto-fix-show-data.js (generation-time
 * gate) and pre-deploy-check.js (self-healing guard).
 *
 * Why this exists: Claude and other LLMs sometimes refuse to generate a
 * synopsis for an unfamiliar show and return a refusal paragraph instead.
 * The old validator only checked length, marketing openers, and trailing
 * punctuation, so "I do not have enough information about the specific plot
 * or premise of X to provide a factual synopsis..." passed every check and
 * was written to shows.json — from where it leaked into the public show
 * page AND the SEO meta description (src/app/show/[slug]/page.tsx:126).
 *
 * Extracted per project rule §15 (Test Extraction Pattern).
 */

// First-person refusal / hedging patterns the LLM emits when it lacks facts.
// Each regex targets a distinct phrasing so we can tell which one tripped.
const REFUSAL_PATTERNS = [
  /\bI do not have\b/i,
  /\bI don't have\b/i,
  /\bI'm afraid I (don't|do not)\b/i,
  /\bI am unable to\b/i,
  /\bI'm unable to\b/i,
  /\bI cannot (write|provide|generate|create|offer)\b/i,
  /\bI can't (write|provide|generate|create|offer)\b/i,
  /\bI'm sorry,? but\b/i,
  /\bI apologi[sz]e,? but\b/i,
  /\bUnfortunately,? I (do not|don't|cannot|can't)\b/i,
  /\bwithout more (details|information|context)\b/i,
  /\bwithout access to (details|information|reliable)\b/i,
  /\bto provide a (factual|concise|informative|brief|specific|accurate) (synopsis|summary|description)\b/i,
  /\b(enough|sufficient) (information|context|details) (about|to|regarding)\b/i,
  /\bbased on the (information|context|details) (provided|given|you provided)\b/i,
  /\bas (requested|an AI)\b/i,
  /\bas a (large )?language model\b/i,
];

/**
 * Returns the first matching refusal pattern, or null.
 * @param {string} text
 * @returns {RegExp | null}
 */
function detectRefusalPattern(text) {
  if (!text || typeof text !== 'string') return null;
  for (const pattern of REFUSAL_PATTERNS) {
    if (pattern.test(text)) return pattern;
  }
  return null;
}

/**
 * True if the text looks like an LLM refusal rather than a real synopsis.
 * @param {string} text
 * @returns {boolean}
 */
function isLlmRefusal(text) {
  return detectRefusalPattern(text) !== null;
}

/**
 * Validate whether text is a genuine synopsis (not accessibility info,
 * marketing copy, truncated text, or an LLM refusal).
 *
 * @param {string} text - Synopsis text to validate
 * @returns {boolean} true if the text is a valid synopsis
 */
function isValidSynopsis(text) {
  if (!text || typeof text !== 'string') return false;

  const trimmed = text.trim();

  // Reject text shorter than 50 characters
  if (trimmed.length < 50) return false;

  // Reject LLM refusals
  if (isLlmRefusal(trimmed)) return false;

  // Reject accessibility keywords (word-boundary to avoid "adaptation" matching "ada")
  const accessibilityPattern = /\bwheelchair\b|\bhearing assist\b|\belevator access\b|\baccessible seating\b|\bada seating\b|\brestrooms\b|\bclosed captioning\b|\bassistive listening\b/i;
  if (accessibilityPattern.test(trimmed)) return false;

  // Reject marketing openers
  if (/^(See |Get tickets|Don't miss|Experience the|Come discover)/i.test(trimmed)) return false;

  // Reject text that ends mid-sentence (ends with comma, or ends with lowercase letter without period)
  if (/,\s*$/.test(trimmed)) return false;
  if (/[a-z]$/.test(trimmed) && !/[.!?'")\]]$/.test(trimmed)) return false;

  return true;
}

module.exports = {
  REFUSAL_PATTERNS,
  detectRefusalPattern,
  isLlmRefusal,
  isValidSynopsis,
};
