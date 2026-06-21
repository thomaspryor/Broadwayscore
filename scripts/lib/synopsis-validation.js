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

// Generic "production-history placeholder" — describes who wrote it / where it
// premiered / that it's transferring, with no actual plot. The canonical shape
// is "<title> is a (stage) play/musical written by <name>." These pass the
// length/refusal/marketing checks but tell a reader nothing about the show.
// 1536 sat live with one of these for weeks (fixed 2026-06-21) because the only
// gate was length. Anchored on "is a … written by" so plot text that merely
// mentions a play-within-a-play ("a play written by his late wife") is safe.
//
// IMPORTANT: the "is a play written by X" opener ALSO appears in perfectly good
// synopses ("X is a play written by Y about [plot]..."), so the opener alone is
// NOT enough — that over-flagged real synopses and made the LLM backfill reject
// its own good output (2026-06-21). A synopsis is a placeholder only when the
// opener is paired with production-history sentences (premiere/transfer dates)
// OR the whole thing is just the bare attribution (no room for a plot).
const PLACEHOLDER_OPENER_RE = /\bis (a|an) (stage play|musical|play|new play|new musical|production)\b[^.]*\bwritten by\b/i;

// Production-history sentences that mark a placeholder when no plot is present.
const PRODUCTION_HISTORY_RE = /\b(had its world premiere|world[- ]?premiered?|premiered (at|in|on)|opened (at|on|in)|scheduled to (transfer|open|begin)|will transfer|transferred (to|from)|is set to (open|transfer|premiere)|made its [^.]{0,30}(debut|premiere)|originally (ran|opened|premiered|produced))\b/i;

// A synopsis this short with the bare attribution opener has no room for a plot.
const BARE_ATTRIBUTION_MAX = 130;

// Future-tense transfer/open/premiere language that goes stale the moment a show
// actually opens ("scheduled to transfer to the West End in 2026" on a show
// that's now playing). Only stale when paired with an open/closed status.
const STALE_FUTURE_RE = /\b(scheduled to|set to|is set to|will|due to|expected to|slated to)\s+(transfer|open|begin|premiere|run|play)\b/i;

const LIVE_STATUSES = new Set(['open', 'now-playing', 'closed']);

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
 * True if the text is a generic production-history placeholder rather than a
 * plot synopsis.
 * @param {string} text
 * @returns {boolean}
 */
function isPlaceholderSynopsis(text) {
  if (!text || typeof text !== 'string') return false;
  if (!PLACEHOLDER_OPENER_RE.test(text)) return false;
  // Opener + production history (premiere/transfer) → placeholder.
  if (PRODUCTION_HISTORY_RE.test(text)) return true;
  // Opener + nothing else of substance → bare attribution placeholder.
  if (text.trim().length < BARE_ATTRIBUTION_MAX) return true;
  return false;
}

/**
 * True if a show's synopsis uses future-tense transfer/open language while the
 * show is already open or closed (stale pre-opening copy).
 * @param {{ synopsis?: string, status?: string }} show
 * @returns {boolean}
 */
function isStaleSynopsis(show) {
  const text = show && show.synopsis;
  if (!text || typeof text !== 'string') return false;
  const status = (show.status || '').toLowerCase();
  if (!LIVE_STATUSES.has(status)) return false;
  return STALE_FUTURE_RE.test(text);
}

/**
 * Classify why a show's synopsis is bad, or null if it's fine. Single source of
 * truth for the freshness gate (check-show-freshness.js) and the deploy-time
 * self-heal (pre-deploy-check.js).
 * @param {{ synopsis?: string, status?: string }} show
 * @returns {{ bad: boolean, reason: 'missing'|'refusal'|'placeholder'|'stale'|'invalid'|null }}
 */
function classifyBadSynopsis(show) {
  const text = show && show.synopsis;
  if (!text || typeof text !== 'string' || text.trim().length < 50) {
    return { bad: true, reason: 'missing' };
  }
  if (detectRefusalPattern(text)) return { bad: true, reason: 'refusal' };
  if (isPlaceholderSynopsis(text)) return { bad: true, reason: 'placeholder' };
  if (isStaleSynopsis(show)) return { bad: true, reason: 'stale' };
  if (!isValidSynopsis(text)) return { bad: true, reason: 'invalid' };
  return { bad: false, reason: null };
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

  // Reject generic production-history placeholders (no plot)
  if (isPlaceholderSynopsis(trimmed)) return false;

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
  PLACEHOLDER_OPENER_RE,
  PRODUCTION_HISTORY_RE,
  STALE_FUTURE_RE,
  detectRefusalPattern,
  isLlmRefusal,
  isPlaceholderSynopsis,
  isStaleSynopsis,
  isValidSynopsis,
  classifyBadSynopsis,
};
