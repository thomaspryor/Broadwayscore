'use strict';

/**
 * WE historical season discovery: the promotion decision (BRO-4851, plan
 * v3.1 docs/specs/west-end-historical-backfill-v3.md).
 *
 * v2.2 required ≥2 independent sources agreeing on title+venue+date, with
 * Theatre Record as discovery and Wikipedia season pages as validation. The
 * Wikipedia season pages don't exist (404 for every season) and TR has no
 * production index, so nothing could ever corroborate. v3.1 discovers from
 * the WhatsOnStage West End listing (dated: previews/opening/closing) and asks
 * a different question: is this a dated West End production that critics
 * reviewed? That needs one review signal (a WOS review post, an Olivier
 * nomination, or a WET roundup), not a second listing.
 *
 * decideWeHistoricalPromotion() is the pure decision — same {promotable,
 * persistent, reason} shape as decideWestEndAggregatorPromotion in
 * promote-we-aggregator-candidates.js. Discover and promote both call it.
 * `persistent: true` means re-running discovery won't change the answer
 * (wrong venue, short run, non-theatre genre); `false` means a later run or
 * a human approval can (no closing date yet, no review signal found).
 */

const { normalizeTitle } = require('./title-match');
const { titlesMatch } = require('./title-normalization');
const { venuesMatch } = require('./deduplication');
const { isWestEndVenue, normalizeVenueName } = require('./venue-classification');
const { isDateInSeason } = require('./we-seasons');

const DEFAULT_DAY_TOLERANCE = 14;
const MIN_RUN_DAYS = 14;

// WOS genre slugs that are not plays or musicals. Opera/dance at the
// Coliseum, concerts, talks, kids' shows and panto are out of scope for
// critic scores (plan v3.1 Goal).
const NON_THEATRE_GENRES = new Set([
  'opera', 'dance', 'ballet', 'concert', 'event', 'conversation', 'talk',
  'special-event', 'special-events', 'live-streaming', 'video-on-demand',
  'film', 'sport', 'attractions', 'cabaret', 'burlesque', 'circus',
  'education-course', 'donation', 'children', 'pantomime', 'panto',
  'comedy-stand-up', 'stand-up',
]);

/**
 * Coarse venue identity for matching SIGNALS (review titles, Olivier lines)
 * to a listing. venuesMatch() alone misses the National Theatre's naming
 * variants ("National Theatre Lyttelton" vs "Lyttelton Theatre", "Olivier
 * (National Theatre)") and "@sohoplace" vs "sohoplace". Not used for
 * shows.json dedup ids — only to decide "is this signal about this listing".
 */
function venueFamily(venue) {
  // Test the RAW name too: normalizeVenueName("National Theatre") is just
  // "national", which no longer says which building it is.
  const raw = String(venue || '').toLowerCase();
  const v = normalizeVenueName(String(venue || '')).toLowerCase();
  const nt = /\bnational theatre\b|\blyttelton\b|\bdorfman\b|^olivier\b|\bolivier \(|\bolivier theatre\b/;
  if (nt.test(raw) || nt.test(v) || v === 'national') return 'national-theatre';
  if (/\broyal court\b|\bjerwood\b/.test(raw)) return 'royal-court';
  // Fold accents first: "Noël Coward" and "Noel Coward" are one building.
  return v.normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/^the\s+/, '').replace(/\s+theatre$/, '').replace(/[^a-z0-9]/g, '');
}

function signalVenueAgrees(a, b) {
  if (!a || !b) return false;
  return venuesMatch(a, b) || venueFamily(a) === venueFamily(b);
}

/**
 * Same production? Title + venue + opening within ±dayTolerance. Fails
 * closed on a missing date: West End venues restage the same title years
 * apart, so title+venue alone is not enough.
 */
function recordsAgree(a, b, opts = {}) {
  if (!a || !b || !a.title || !b.title || !a.venue || !b.venue) return false;
  const dayTolerance = opts.dayTolerance ?? DEFAULT_DAY_TOLERANCE;
  if (normalizeTitle(a.title) !== normalizeTitle(b.title)) return false;
  // venuesMatch(), not canonicalVenue() — its first-word fallback collapses
  // unrelated venues sharing a leading word (BRO-243).
  if (!venuesMatch(a.venue, b.venue)) return false;
  if (!a.openingDate || !b.openingDate) return false;
  const da = new Date(a.openingDate);
  const db = new Date(b.openingDate);
  if (isNaN(da.getTime()) || isNaN(db.getTime())) return false;
  return Math.abs(da - db) / 86400000 <= dayTolerance;
}

/**
 * Does a review/award signal refer to this listing? Title must match; the
 * signal's venue (when it has one) must be the same venue family; a dated
 * signal must fall between previews − 30 days and closing + 120 days (WOS
 * reviews) — Olivier signals carry no date and are matched on title+venue.
 *
 * @param {{title: string, venue?: string|null, venues?: string[], date?: string|null}} signal
 * @param {{title: string, venue: string, previewsStartDate?: string|null, openingDate?: string|null, closingDate?: string|null}} listing
 */
function signalMatchesListing(signal, listing) {
  if (!signal?.title || !listing?.title) return false;
  if (!titlesMatch(signal.title, listing.title)) return false;
  const venues = signal.venues || (signal.venue ? [signal.venue] : []);
  if (venues.length && !venues.some(v => signalVenueAgrees(v, listing.venue))) return false;
  if (signal.date) {
    const start = Date.parse(listing.previewsStartDate || listing.openingDate || '');
    if (Number.isNaN(start)) return false;
    const end = Date.parse(listing.closingDate || '') || start + 365 * 86400000;
    const d = Date.parse(signal.date);
    if (Number.isNaN(d) || d < start - 30 * 86400000 || d > end + 120 * 86400000) return false;
  }
  return true;
}

/**
 * @param {{title: string, venue: string|null, previewsStartDate?: string|null, openingDate?: string|null,
 *          closingDate?: string|null, genres?: string[], signals?: string[], season: string}} candidate
 * @param {{today?: string}} [opts] today = YYYY-MM-DD (injectable for tests)
 * @returns {{promotable: boolean, persistent: boolean, reason: string}}
 */
function decideWeHistoricalPromotion(candidate, opts = {}) {
  const today = opts.today || new Date().toISOString().slice(0, 10);
  const no = (reason, persistent) => ({ promotable: false, persistent, reason });
  if (!candidate?.title) return no('no title', true);
  if (!candidate.venue) return no('no venue', true);
  if (!isWestEndVenue(candidate.venue)) return no(`not a West End venue: ${candidate.venue}`, true);
  const start = candidate.openingDate || candidate.previewsStartDate;
  if (!start) return no('no opening or previews date', false);
  if (!isDateInSeason(start, candidate.season)) return no(`starts ${start}, outside season ${candidate.season}`, true);
  const genres = candidate.genres || [];
  const offGenre = genres.find(g => NON_THEATRE_GENRES.has(g));
  if (offGenre) return no(`non-theatre genre: ${offGenre}`, true);
  if (!candidate.closingDate) return no('no closing date', false);
  if (candidate.closingDate >= today) return no(`not closed yet (closes ${candidate.closingDate})`, false);
  // Measure the run from the FIRST performance: a late press night (Macbeth,
  // Harold Pinter 2024: previews 10-01, opening 12-08, closing 12-14) is a
  // ten-week run, not a six-day one.
  const runStart = candidate.previewsStartDate || start;
  const runDays = (Date.parse(candidate.closingDate) - Date.parse(runStart)) / 86400000;
  if (!(runDays >= MIN_RUN_DAYS)) return no(`run of ${Math.round(runDays)} days < ${MIN_RUN_DAYS}`, true);
  if (!(candidate.signals || []).length) return no('no review signal (WOS review, Olivier nomination)', false);
  return { promotable: true, persistent: true, reason: `signals: ${candidate.signals.join(', ')}` };
}

module.exports = {
  MIN_RUN_DAYS,
  NON_THEATRE_GENRES,
  venueFamily,
  recordsAgree,
  signalMatchesListing,
  decideWeHistoricalPromotion,
};
