// Pure show-selection, query and date-window decisions for
// scripts/discover-regional-serp-reviews.js. They live in scripts/lib/ so the
// colocated test is covered by test.yml's scripts/lib/** trigger (BRO-4509).
const { calculateDateWindow } = require('./url-discovery');

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
// rolling window instead: the last TOUR_LOOKBACK_DAYS, never before the
// shared window's start, never past closingDate + 30.
const TOUR_LOOKBACK_DAYS = 120;
function buildDiscoveryDateRange(show, now = new Date()) {
  const base = calculateDateWindow(show);
  if (show.market !== 'tour' || !base) return base;
  const day = 24 * 60 * 60 * 1000;
  const lookback = new Date(now.getTime() - TOUR_LOOKBACK_DAYS * day);
  const ends = [now.getTime() + 30 * day];
  if (show.closingDate) ends.push(new Date(show.closingDate).getTime() + 30 * day);
  const dateMin = base.dateMin && base.dateMin > lookback ? base.dateMin : lookback;
  const dateMax = new Date(Math.min(...ends));
  // A tour that closed more than ~150 days ago would invert the range (a paid
  // SERP call that can only return nothing); search its shared window instead,
  // as closed regional shows do.
  if (dateMax < dateMin) return base;
  return { dateMin, dateMax };
}

module.exports = { DISCOVERY_MARKETS, selectDiscoveryShows, buildDiscoveryQuery, buildDiscoveryDateRange, cityFromVenue };
