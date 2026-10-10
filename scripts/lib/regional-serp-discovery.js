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

// A tour candidate is a review of the touring company, found by a tour query
// ("<title>" national tour review) or by the per-stop city search. Both also
// surface things that are not: the original Broadway run's reviews, overseas
// productions, and non-review pages about the tour. Decided by what the page IS,
// never by whether it says "tour": a local review of the touring company
// routinely names no tour ("Broadway in Santa Barbara", "Hancher's Broadway
// series", BroadwayWorld /central-new-york/) and used to be rejected for the
// word "broadway" or "new-york" alone (BRO-4931: 0 reviews on kinky-boots-tour-2025).
// The date window (SERP dateRange + ingest --date-window) keeps Broadway-era
// reviews out; this function only judges the page itself.
const TOUR_MARKER = /\btour(s|ing|ed)?\b|national[-\s]tour/i;

// Outlets that review the New York production, not a tour stop. A hit here with
// no tour word is the Broadway company's review.
const NYC_MARKET_HOSTS = new Set([
  'nytimes.com', 'vulture.com', 'nymag.com', 'newyorker.com', 'variety.com', 'nypost.com', 'nydailynews.com',
  'amny.com', 'newsday.com', 'broadway.com', 'newyorkstagereview.com', 'newyorktheatreguide.com',
  'talkinbroadway.com', 'broadwaynews.com', 'wsj.com',
]);
// (TheaterMania, Hollywood Reporter, Deadline and Playbill are left out on purpose:
// they also review tour stops, e.g. a TheaterMania review of Hell's Kitchen at the Pantages.)
// BroadwayWorld first path segments that are the New York company, not a region.
const BWW_NYC_SECTIONS = new Set(['article', 'off-broadway', 'off-off-broadway', 'broadway', 'nyc', 'new-york-city', 'cabaret']);
// BroadwayWorld editions outside the US, Canada and Mexico (tours play those only).
const BWW_OVERSEAS_SECTIONS = new Set([
  'uk', 'uk-regional', 'london', 'west-end', 'belgium', 'australia', 'new-zealand', 'germany', 'france', 'netherlands',
  'spain', 'italy', 'portugal', 'sweden', 'norway', 'denmark', 'finland', 'poland', 'czech', 'hungary', 'greece',
  'ireland', 'austria', 'switzerland', 'russia', 'turkey', 'israel', 'india', 'japan', 'korea', 'china', 'hong-kong',
  'taiwan', 'singapore', 'philippines', 'south-africa', 'brazil', 'argentina', 'chile', 'dubai',
]);
// Interviews, previews, features and press items are never a review, whatever
// the outlet (the Chicago "InterviewFeature-KINKY-BOOTS-Dancing-in-Heels-Workshop"
// page was ingested as a review). Checked on the URL path and title only.
const NON_REVIEW_KIND = /interviewfeature|(?:^|[^a-z])(?:interview|previews?|sneak[-\s]peek|meet[-\s]the[-\s]cast|photos?|video|press[-\s]release|now[-\s]playing|on[-\s]sale|tickets?|auditions?|casting)(?:$|[^a-z])/i;
// Broadway-company phrasing that survives without a tour word. "ran on Broadway"
// in a local review is fine; "returns to Broadway" is the New York run.
const BROADWAY_COMPANY_TEXT = /\b(?:returns?|back|heads?|moves?|transfers?|opens?|opening|debuts?|currently|now)\s+(?:on|to|at)\s+broadway\b|\bnyc\b|\bnew[-\s]york[-\s]city\b/i;

function hostAndPath(url) {
  try {
    const u = new URL(url);
    return { host: u.hostname.toLowerCase().replace(/^www\./, ''), segments: u.pathname.split('/').filter(Boolean) };
  } catch { return { host: '', segments: [] }; }
}

function hostInSet(host, set) {
  const parts = host.split('.');
  for (let i = 0; i < parts.length - 1; i++) if (set.has(parts.slice(i).join('.'))) return true;
  return false;
}

// Pure verdict for one tour candidate: { ok, reason }. Non-tour shows always pass.
function tourCandidateVerdict(show, candidate) {
  if (show.market !== 'tour') return { ok: true, reason: null };
  const url = candidate.url || '';
  // An overseas production's review (Spamalot's Melbourne season, BRO-4656):
  // tours here play the US, Canada and Mexico only.
  if (isOverseasHost(url)) return { ok: false, reason: 'overseas' };
  const { host, segments } = hostAndPath(url);
  const isBww = host === 'broadwayworld.com' || host.endsWith('.broadwayworld.com');
  const articleAt = segments.indexOf('article');
  if (isBww) {
    if (segments.some((seg, i) => i < Math.max(articleAt, 1) && BWW_OVERSEAS_SECTIONS.has(seg.toLowerCase()))) return { ok: false, reason: 'overseas' };
    // BroadwayWorld reviews are /<region>/article/Review-<SHOW>-at-<VENUE>-<date>;
    // interviews, "is Now Playing" releases and photo pages share the path shape.
    const slug = articleAt >= 0 ? segments[articleAt + 1] || '' : '';
    if (!/^(?:bww-)?review-/i.test(slug) || /roundup/i.test(slug)) return { ok: false, reason: 'non-review' };
  }
  let pathText = '';
  try { pathText = decodeURIComponent(segments.join('/')); } catch { pathText = segments.join('/'); }
  if (NON_REVIEW_KIND.test(`${pathText} ${candidate.title || ''}`)) return { ok: false, reason: 'non-review' };
  const text = `${url} ${candidate.title || ''} ${candidate.snippet || candidate.description || ''}`;
  if (TOUR_MARKER.test(text)) return { ok: true, reason: null };
  // No tour word: the page is the touring company's unless it is the New York company's.
  const nycHost = hostInSet(host, NYC_MARKET_HOSTS) || (host === 'timeout.com' && segments[0] === 'newyork')
    || (isBww && (segments.length === 0 || BWW_NYC_SECTIONS.has((segments[0] || '').toLowerCase())));
  if (nycHost) return { ok: false, reason: 'broadway-company' };
  if (BROADWAY_COMPANY_TEXT.test(`${candidate.title || ''} ${candidate.snippet || candidate.description || ''}`)) return { ok: false, reason: 'broadway-company' };
  return { ok: true, reason: null };
}

function tourCandidateIsTour(show, candidate) {
  return tourCandidateVerdict(show, candidate).ok;
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


module.exports = { normalizeUrl, looksLikeAggregationOrReaction, resolveRegisteredOutlet, DISCOVERY_MARKETS, selectDiscoveryShows, buildDiscoveryQuery, buildDiscoveryDateRange, tourCandidateIsTour, tourCandidateVerdict, cityFromVenue };
