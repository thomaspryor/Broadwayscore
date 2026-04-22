/**
 * Paywall detector — catches hard-paywall prompts that leak into fullText when
 * subscriber cookies fail or aren't available for the requested domain.
 *
 * Complements scripts/lib/content-quality.js:detectPaywall (which runs broad
 * pattern matching anywhere in the text for the LLM-scoring garbage filter).
 * This detector is stricter and POSITIONAL — a paywall wall starts with
 * "subscribe to continue" within the first N characters, not at the end.
 *
 * Use at ingest time (opening-night-poller, collect-review-texts) to mark a
 * fetched page as paywalled and skip writing a review-text file that would
 * otherwise be scored off a paywall prompt.
 *
 * Context from 2026-04-22 audit of /Users/tompryor/broadway-review-texts:
 *   788 WSJ review files
 *   311 marked textQuality=truncated
 *   Only 5 contain explicit paywall boilerplate in fullText
 * So the hard-paywall leak is rare but worth guarding against — a P0 leak
 * on an opening night (wrong score on a T2 outlet) costs more than the
 * handful of files this catches.
 */

// Positional paywall prompts — specific enough to avoid collision with the
// quoted word "subscribe" in an actual review, and focused on the verbs
// WSJ/FT/Telegraph/WAPO/NYT use at the TOP of the locked article body.
const PAYWALL_START_MARKERS = [
  /^\s*(subscribe|sign in)\s+(to\s+)?(continue|read|access|view)/i,
  /^\s*(already (a|an) (member|subscriber))/i,
  /^\s*continue reading (your|this) article with/i,
  /^\s*to (read|keep reading|access) (the )?(full )?(article|story|review)/i,
  /^\s*this (article|story) is (for|available to) (members|subscribers)/i,
  /^\s*log in to (continue|read|access)/i,
];

// Outlet-specific markers — phrases that appear verbatim in paywall overlays.
// Matched anywhere in the TOP of the text (first 600 chars) since WSJ/FT often
// render "Already a subscriber?" as a sub-header after a title.
const OUTLET_HARD_MARKERS = {
  'wsj.com': [
    /WSJ (Membership|Subscribe)/i,
    /journal\s+membership/i,
    /create (a|an) (free )?account to continue/i,
    /Already a subscriber\?.*Sign In/is,
  ],
  'ft.com': [
    /FT Edit|FT Digital|FT Subscribe/i,
  ],
  'nytimes.com': [
    /To read this article, (subscribe|register)/i,
    /Create your free account/i,
  ],
  'washingtonpost.com': [
    /Subscribe to The Washington Post/i,
  ],
  'telegraph.co.uk': [
    /Register for free.*continue reading/i,
  ],
};

/**
 * Detect a paywall overlay at the START of the text, plus outlet-specific
 * hard markers in the first 600 chars.
 *
 * @param {string} text — the fullText field
 * @param {string} [urlOrDomain] — optional URL or domain for outlet-specific checks
 * @returns {{ detected: boolean, marker: string|null, reason: string|null }}
 */
function detectHardPaywall(text, urlOrDomain) {
  if (!text || typeof text !== 'string') {
    return { detected: false, marker: null, reason: null };
  }
  const head = text.slice(0, 600);

  for (const pattern of PAYWALL_START_MARKERS) {
    const m = head.match(pattern);
    if (m) {
      return {
        detected: true,
        marker: m[0].trim(),
        reason: 'paywall-start-marker',
      };
    }
  }

  const domain = extractDomain(urlOrDomain);
  if (domain && OUTLET_HARD_MARKERS[domain]) {
    for (const pattern of OUTLET_HARD_MARKERS[domain]) {
      const m = head.match(pattern);
      if (m) {
        return {
          detected: true,
          marker: m[0].trim().slice(0, 80),
          reason: `paywall-outlet-marker:${domain}`,
        };
      }
    }
  }

  return { detected: false, marker: null, reason: null };
}

function extractDomain(urlOrDomain) {
  if (!urlOrDomain || typeof urlOrDomain !== 'string') return null;
  try {
    // If it's a URL
    if (urlOrDomain.includes('://')) {
      const h = new URL(urlOrDomain).hostname.replace(/^www\./, '');
      return h;
    }
  } catch {
    // fall through
  }
  return urlOrDomain.replace(/^www\./, '');
}

module.exports = {
  detectHardPaywall,
  PAYWALL_START_MARKERS,
  OUTLET_HARD_MARKERS,
};
