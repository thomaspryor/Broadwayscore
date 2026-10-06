// Pure show-selection, query and date-window decisions for
// scripts/discover-regional-serp-reviews.js. They live in scripts/lib/ so the
// colocated test is covered by test.yml's scripts/lib/** trigger (BRO-4509).
const { calculateDateWindow } = require('./url-discovery');
const { _parseDomain, lookupOutletForHost } = require('./outlet-canonicalize');
const { isOverseasHost } = require('./domain-filters');

// A show stays in the discovery pool while open, or for ~15 months after
// closing (or after opening, if closingDate is unknown) — long enough to
// cover the Dolly-style case where the transfer/rescore lag is many months,
// short enough that the pool doesn't grow unbounded as regional history
// accumulates (little-bear-ridge-road-2024, closed 2+ years, drops out).
const POOL_WINDOW_DAYS = 450;

function ageInDays(dateStr) {
  if (!dateStr) return Infinity;
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000);
}

function cityFromVenue(venue) {
  if (!venue || typeof venue !== 'string') return null;
  // "Venue Name, City, ST" — city is the second-to-last comma segment.
  const parts = venue.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  return parts[parts.length - 2];
}

// National tours (market 'tour') join the pool: their review corpus is the same
// kind of local tour-stop coverage, and before BRO-4509 nothing searched for it
// (oh-mary-tour-2026 and maybe-happy-ending-tour-2026 sat at 0 reviews).
const DISCOVERY_MARKETS = new Set(['regional', 'tour']);

function selectDiscoveryShows(shows, filter) {
  return shows.filter((s) => {
    if (!DISCOVERY_MARKETS.has(s.market)) return false;
    if (filter) return s.id === filter;
    if (s.status === 'open' || s.status === 'previews') return true;
    const age = Math.min(ageInDays(s.closingDate), s.closingDate ? Infinity : ageInDays(s.openingDate));
    return age <= POOL_WINDOW_DAYS;
  });
}

// A tour's venue is "North American Tour" (no city) and its reviews come from
// whichever city it is playing, so the query names the tour instead of a city.
// Returns null when no query can be built (regional show with no parsable city).
function buildDiscoveryQuery(show) {
  if (show.market === 'tour') return `"${show.title}" national tour review`;
  const city = cityFromVenue(show.venue);
  return city ? `"${show.title}" review ${city}` : null;
}

// The shared window caps at openingDate + 180, which for a tour that has been
// on the road a year means every weekly search re-scans a frozen, long-past
// window and never sees reviews from the cities it plays now. Tours get a
// rolling window instead: the TOUR_LOOKBACK_DAYS before its anchor (today, or
// closingDate for a tour that has already closed, so its final months stay
// searchable for the whole pool window), never before the shared window's
// start, ending anchor + 30. A tour with no openingDate (no shared window)
// still gets this bounded range instead of an unbounded search.
const TOUR_LOOKBACK_DAYS = 120;
function buildDiscoveryDateRange(show, now = new Date()) {
  const base = calculateDateWindow(show);
  if (show.market !== 'tour') return base;
  const day = 24 * 60 * 60 * 1000;
  const closed = show.closingDate ? new Date(show.closingDate) : null;
  const anchor = closed && !isNaN(closed) && closed < now ? closed : now;
  const lookback = new Date(anchor.getTime() - TOUR_LOOKBACK_DAYS * day);
  const dateMin = base && base.dateMin && base.dateMin > lookback ? base.dateMin : lookback;
  const dateMax = new Date(anchor.getTime() + 30 * day);
  if (dateMax < dateMin) return base;
  return { dateMin, dateMax };
}

// The tour query ("<title>" national tour review) also matches the original
// Broadway run's reviews, which belong to the Broadway show, not the tour.
// Reject a tour candidate that points at Broadway/New York and never mentions
// a tour. A plain "Review: <title>" from a tour-stop paper (no marker either
// way) still passes; the date window and validateSerpCandidate cover the rest.
const TOUR_MARKER = /\btour(s|ing|ed)?\b|national[-\s]tour/i;
const BROADWAY_MARKER = /\bbroadway\b|\bnew[-\s]york\b|\bnyc\b|nytimes\.com/i;
function tourCandidateIsTour(show, candidate) {
  if (show.market !== 'tour') return true;
  // An overseas production's review (Spamalot's Melbourne season, BRO-4656):
  // tours here play the US, Canada and Mexico only.
  if (isOverseasHost(candidate.url)) return false;
  const text = `${candidate.url || ''} ${candidate.title || ''} ${candidate.snippet || candidate.description || ''}`;
  if (TOUR_MARKER.test(text)) return true;
  return !BROADWAY_MARKER.test(text);
}

function normalizeUrl(url) {
  return (url || '').toLowerCase().replace(/\/$/, '');
}

// Roundup/aggregation pages (BWW "Review Roundup", Playbill "Read the Reviews")
// and audience-reaction pieces are not single-critic reviews. The downstream
// write path (review-file-writer.js isRoundupPageAsReview) already excludes
// roundup pages from scoring, but skipping them here avoids a wasted fetch and
// an outlet--critic slot claimed by a page that isn't a review at all.
const NON_REVIEW_MARKERS = /\b(review roundup|critics? sound off|read the reviews|what critics? (?:are|is) saying|reactions?|reacts? to)\b/i;

function looksLikeAggregationOrReaction(url, title) {
  return NON_REVIEW_MARKERS.test(title || '') || NON_REVIEW_MARKERS.test(decodeURIComponent(url || ''));
}

function resolveRegisteredOutlet(url) {
  const domain = _parseDomain(url);
  if (!domain) return null;
  // exactOnly: this automated path ingests whatever it resolves; a parent-domain
  // match would turn forum.broadwayworld.com threads into BroadwayWorld reviews.
  return lookupOutletForHost(domain, { exactOnly: true });
}


module.exports = { normalizeUrl, looksLikeAggregationOrReaction, resolveRegisteredOutlet, DISCOVERY_MARKETS, selectDiscoveryShows, buildDiscoveryQuery, buildDiscoveryDateRange, tourCandidateIsTour, cityFromVenue };
