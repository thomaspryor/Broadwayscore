/*
 * verifyAggregatorUrl — URL-stage show-match gate (S1-T4).
 *
 * Used by SERP-discovered aggregator URLs (theatre.reviews, thestage.co.uk,
 * westendtheatre.com, broadwayworld.com, stagedoor.com, theatrerecord.com)
 * to reject wrong-show URLs BEFORE the page body is parsed and saved.
 *
 * Why not reuse verifyProduction(): that helper is shaped around publishDate
 * + body text + KNOWN_WRONG_INDICATORS for date/venue triangulation. It
 * intentionally treats London venues as expected for WE shows. That makes it
 * blind to The Stage's native-search trap (returns
 * /review-round-ups/one-flew-over-the-cuckoos-nest-... for any query) which
 * is a URL-slug-stage mismatch.
 *
 * Interface:
 *   verifyAggregatorUrl({ url, html, show, openingDate? })
 *     → { isValid, confidence, rejectReason, signals }
 *
 *   show must have { id, title }. Optional { venue, openingDate, category }.
 *
 * Confidence ladder when isValid===true:
 *   'high'   — URL slug token match AND (page-title token match OR venue body match)
 *   'medium' — URL slug token match only (e.g. html not supplied)
 *   'low'    — slug match weak (1 short significant token) and no html corroboration
 *
 * rejectReason (when isValid===false):
 *   'no-significant-title-tokens'    — show title has zero usable tokens
 *   'url-token-mismatch'             — URL slug shares no significant title token
 *   'page-title-mismatch'            — page <title> contains a strong wrong-show token
 *                                       (used to catch the Stage Cuckoo's trap)
 *   'date-out-of-window'             — opening date provided + URL has explicit
 *                                       year > 2 years off
 */

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'of', 'and', 'or', 'on', 'in', 'at', 'to', 'is', 'it',
  'for', 'with', 'from', 'by', 'as', 'be',
]);

// Stage trap canary tokens — narrowed in ship-check P1-2 fix. Previously
// included bare 'flew' and 'nest'; any unrelated WE show with a slug or
// title containing those words was getting page-title-mismatch rejected.
// Keep the 'cuckoo'-flavoured tokens only (distinctive enough singly).
const STAGE_TRAP_TOKENS = ['cuckoo', 'cuckoos', 'cuckoonest'];

function titleTokens(title) {
  if (!title) return [];
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOP_WORDS.has(w));
}

function urlSlugTokens(url) {
  if (!url) return [];
  let pathPart = '';
  try {
    pathPart = new URL(url).pathname.toLowerCase();
  } catch {
    pathPart = String(url).toLowerCase();
  }
  return pathPart
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function extractHtmlTitle(html) {
  if (!html) return '';
  const m = html.match(/<title[^>]*>([\s\S]{0,500}?)<\/title>/i);
  if (!m) return '';
  return m[1]
    .replace(/&amp;/g, '&')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .trim()
    .toLowerCase();
}

// Ship-check P1-3 fix: bare substring `includes()` matched "Globe Theatre"
// on any page mentioning "globe" anywhere (and "Park Theatre" → "park"),
// opening the URL-slug-bypass to false positives. Require the venue to
// appear as a whole-token sequence (non-alphanumeric boundaries), and skip
// generic single-word venues whose primary token is too common to match
// safely. "London Palladium" is fine; "Globe Theatre" relies on the longer
// "globe theatre" sequence to anchor.
const GENERIC_VENUE_TOKENS = new Set([
  'globe', 'park', 'palace', 'studio', 'arts', 'theatre', 'theater',
  'playhouse', 'open', 'national', 'royal',
]);
function bodyContainsVenue(html, venue) {
  if (!html || !venue) return false;
  const v = venue.trim().toLowerCase();
  if (!v) return false;
  // Refuse to match when the venue's distinguishing token is a generic
  // single word (avoid "Globe Theatre" → "globe" anywhere in body trick).
  const firstToken = v.split(/\s+/)[0];
  if (firstToken.length < 5 || (v.split(/\s+/).length === 1 && GENERIC_VENUE_TOKENS.has(firstToken))) {
    return false;
  }
  const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, 'i');
  return re.test(html);
}

function explicitUrlYear(url) {
  if (!url) return null;
  const path = url.replace(/^https?:\/\/[^/]+/i, '');
  // 1) 8-digit date string anywhere in the path: YYYYMMDD → take year
  const dateM = path.match(/(?:^|[^\d])(20[012]\d|19\d{2})(0[1-9]|1[012])(0[1-9]|[12]\d|3[01])(?:[^\d]|$)/);
  if (dateM) return parseInt(dateM[1], 10);
  // 2) Standalone 4-digit year segment
  const m = path.match(/(?:^|[\/_-])(20[012]\d|19\d{2})(?:[\/_-]|$)/);
  return m ? parseInt(m[1], 10) : null;
}

function openingYearOf(show, openingDateOverride) {
  const d = openingDateOverride || show.openingDate;
  if (!d) return null;
  const m = String(d).match(/(20\d{2}|19\d{2})/);
  return m ? parseInt(m[1], 10) : null;
}

function verifyAggregatorUrl({ url, html, show, openingDate } = {}) {
  const signals = {};
  if (!show || !show.title) {
    return {
      isValid: false,
      confidence: 'low',
      rejectReason: 'no-significant-title-tokens',
      signals,
    };
  }

  const tTokens = titleTokens(show.title);
  signals.titleTokens = tTokens;
  if (tTokens.length === 0) {
    return {
      isValid: false,
      confidence: 'low',
      rejectReason: 'no-significant-title-tokens',
      signals,
    };
  }

  const sTokens = urlSlugTokens(url);
  signals.urlSlugTokens = sTokens;
  const slugMatches = tTokens.filter(t => sTokens.includes(t));
  signals.slugMatches = slugMatches;

  const pageTitle = extractHtmlTitle(html);
  signals.pageTitle = pageTitle || null;
  const pageTitleMatches = pageTitle
    ? tTokens.filter(t => pageTitle.includes(t))
    : [];
  signals.pageTitleMatches = pageTitleMatches;

  // Stage trap: when SERP returns the Cuckoo's Nest roundup for an unrelated
  // show, the URL slug contains 'cuckoo'/'nest'/'flew' but the show is not.
  // Reject when those tokens appear in URL but none of the title tokens do.
  const slugHasTrap = STAGE_TRAP_TOKENS.some(t => sTokens.includes(t));
  const titleHasTrap = STAGE_TRAP_TOKENS.some(t => tTokens.includes(t));
  if (slugHasTrap && !titleHasTrap && slugMatches.length === 0) {
    return {
      isValid: false,
      confidence: 'high',
      rejectReason: 'page-title-mismatch',
      signals: { ...signals, trap: 'stage-cuckoo' },
    };
  }

  // Page title trap: if html available and page <title> name-drops a strong
  // wrong-show token (no overlap with our show), reject regardless of slug.
  if (pageTitle && pageTitleMatches.length === 0) {
    const trapInTitle = STAGE_TRAP_TOKENS.some(t => pageTitle.includes(t)) && !titleHasTrap;
    if (trapInTitle) {
      return {
        isValid: false,
        confidence: 'high',
        rejectReason: 'page-title-mismatch',
        signals: { ...signals, trap: 'page-title-cuckoo' },
      };
    }
  }

  // URL slug mismatch is fatal UNLESS the page title or venue body corroborates
  // the match (e.g. FT articles use opaque hash URLs but the <title> still
  // names the show). Without any html signal it stays a hard reject.
  if (slugMatches.length === 0) {
    const venueInBody = bodyContainsVenue(html, show.venue);
    if (pageTitleMatches.length === 0 && !venueInBody) {
      return {
        isValid: false,
        confidence: 'high',
        rejectReason: 'url-token-mismatch',
        signals,
      };
    }
    signals.urlSlugBypass = 'page-or-venue';
  }

  // Date sanity: BWW URL with embedded date 2+ years off the opening date is
  // likely a prior-production roundup (e.g. 2012 Broadway Evita resurfacing
  // for the 2025 WE production).
  const urlYear = explicitUrlYear(url);
  const expectedYear = openingYearOf(show, openingDate);
  signals.urlYear = urlYear;
  signals.expectedYear = expectedYear;
  if (urlYear && expectedYear && Math.abs(urlYear - expectedYear) > 2) {
    return {
      isValid: false,
      confidence: 'high',
      rejectReason: 'date-out-of-window',
      signals,
    };
  }

  const venueInBody = bodyContainsVenue(html, show.venue);
  signals.venueInBody = venueInBody;

  // Confidence:
  //   high   — slug matches AND (page-title token match OR venue body match)
  //          — OR slug bypass via page-title + venue body (both corroborate)
  //   medium — slug matches only (no html corroboration available)
  //          — OR slug bypass via page-title only
  //   low    — just 1 short slug match and no html corroboration
  let confidence;
  const corroboration = (pageTitleMatches.length > 0 ? 1 : 0) + (venueInBody ? 1 : 0);
  if (slugMatches.length > 0 && corroboration >= 1) {
    confidence = 'high';
  } else if (slugMatches.length === 0 && corroboration >= 2) {
    confidence = 'high';
  } else if (slugMatches.length === 0 && corroboration === 1) {
    confidence = 'medium';
  } else if (!pageTitle && !html) {
    confidence = slugMatches.length >= 2 || slugMatches.some(t => t.length >= 5)
      ? 'medium'
      : 'low';
  } else {
    confidence = slugMatches.length >= 2 ? 'medium' : 'low';
  }

  return { isValid: true, confidence, rejectReason: null, signals };
}

module.exports = { verifyAggregatorUrl, titleTokens, urlSlugTokens, extractHtmlTitle };
