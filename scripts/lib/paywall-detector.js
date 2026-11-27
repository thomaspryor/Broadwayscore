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
 * hard markers in the first 600 chars. The explicit Pages on Stages paid
 * prompt may follow the public lede.
 *
 * @param {string} text — the fullText field
 * @param {string} [urlOrDomain] — optional URL or domain for outlet-specific checks
 * @returns {{ detected: boolean, marker: string|null, reason: string|null }}
 */
function detectHardPaywall(text, urlOrDomain) {
  if (!text || typeof text !== 'string') {
    return { detected: false, marker: null, reason: null };
  }
  // BRO-8264: this explicit paid-content prompt follows the public lede.
  // The generic WordPress subscription footer is deliberately not a signal.
  if (extractDomain(urlOrDomain) === 'pagesonstages.com' && /log in or pay to keep reading/i.test(text)) {
    return { detected: true, marker: 'Log in or pay to keep reading', reason: 'subscriber-paywall' };
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

/**
 * A registration wall rendered INTO the extracted body (Telegraph sign-up form
 * text after a byline and one standfirst paragraph). The start-of-text check
 * misses it because the wall sits at the end of a ~1.5k-char stub, and the
 * scorer then rates the stub (a Cinderella stub scored 86, BRO-6183).
 */
const REGISTRATION_WALL_TAIL = /A minimum of 8 characters\s+At least 1 letter\s+At least 1 number/i;
function hasRegistrationWallTail(text) {
  return typeof text === 'string' && REGISTRATION_WALL_TAIL.test(text);
}

/**
 * A page that is a registration-wall STUB: the sign-up form text sits behind
 * only a byline/standfirst/bio (under REGISTRATION_WALL_STUB_MAX_PRE chars of
 * real text). The same form text trailing a full article (page footer) is not
 * a stub: those carry the review ahead of it. BRO-6190: Telegraph stubs
 * (avenue-q 82, cinderella 86) were classed complete/truncated and scored.
 */
const REGISTRATION_WALL_STUB_MAX_PRE = 2500;
function isRegistrationWallStub(text) {
  if (typeof text !== 'string') return false;
  const m = REGISTRATION_WALL_TAIL.exec(text);
  return !!m && m.index < REGISTRATION_WALL_STUB_MAX_PRE;
}

/** Read the raw HTML while the paid prompt still exists. A subscriber-view
 * class alone also occurs around content available to logged-in readers.
 */
function detectSubscriberPaywall(html, url) {
  const absent = { detected: false, marker: null, reason: null };
  if (extractDomain(url) !== 'pagesonstages.com' || typeof html !== 'string' || !html) return absent;
  const $ = require('cheerio').load(html);
  $('script, style, noscript').remove();
  const text = $.root().text().replace(/\s+/g, ' ').trim();
  return /log in or pay to keep reading/i.test(text)
    ? { detected: true, marker: 'Log in or pay to keep reading', reason: 'subscriber-paywall' }
    : absent;
}

function paywallTextHash(text) {
  // Furniture removal is not article recovery. Use the storage cleaner so
  // later normalization cannot release the same paid teaser for scoring.
  const cleaned = require('./text-cleaning').cleanText(String(text || ''));
  return require('crypto').createHash('sha256').update(cleaned.replace(/\s+/g, ' ').trim()).digest('hex');
}

/** Stamp only the fetched body that the writer actually kept, never a retained
 * complete copy or a refused URL replacement. Hash binding releases a later
 * full-text recovery without trusting stale flags from a previous fetch.
 * Returns whether the record changed, including a metadata-only refetch.
 */
function stampSubscriberPaywall(data, html, url, fetchedText) {
  if (!data || !data.fullText || !fetchedText || data.url !== url
      || !detectSubscriberPaywall(html, url).detected
      || paywallTextHash(data.fullText) !== paywallTextHash(fetchedText)) return false;
  const hash = paywallTextHash(data.fullText);
  const changed = data.paywalled !== true || data.paywallTextHash !== hash;
  data.paywalled = true;
  data.paywallTextHash = hash;
  return changed;
}

function isPaywalledText(data) {
  if (data && detectHardPaywall(data.fullText, data.url).reason === 'subscriber-paywall') return true;
  return !!(data && data.paywalled === true && data.paywallTextHash
    && data.paywallTextHash === paywallTextHash(data.fullText));
}

module.exports = {
  detectSubscriberPaywall,
  stampSubscriberPaywall,
  isPaywalledText,
  hasRegistrationWallTail,
  isRegistrationWallStub,
  detectHardPaywall,
  PAYWALL_START_MARKERS,
  OUTLET_HARD_MARKERS,
};
