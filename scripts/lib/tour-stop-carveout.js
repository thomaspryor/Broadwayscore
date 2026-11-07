'use strict';

/**
 * Own-venue carve-out for content verification (BRO-4884): tour stops and
 * venue-taxonomy objections at the record's own theatre.
 *
 * Many West End and Off-West End records ARE a touring production's stop at
 * that theatre: Curtains 2019 at Wyndham's, the National Theatre's A Taste of
 * Honey at Trafalgar Studios, Two Halves of Guinness at Park Theatre. The
 * verifier's wrong-production examples list "UK touring production", so it
 * flagged genuine reviews of those runs ("it reviews the UK touring
 * production at Wyndham's") and the rebuild dropped them. A reworded prompt
 * could only be tested on stand-in models, so the decision is made here
 * instead: the verifier reports the theatre the critic attended
 * (reviewedVenue), and a touring-based wrongProduction is cleared when that
 * theatre is this record's own venue and the review is not dated far
 * outside this run. Reviews of the tour at Sheffield or Leeds stay flagged.
 * The same holds for records filed as West End at subsidised or Off-West End
 * houses: Translations 2019 at the Olivier had its reviews flagged as "a
 * National Theatre production, not the West End production at the Olivier".
 */

const { venueTokens, containsToken, normalizeForMatch } = require('./venue-tokens');

const TOUR_BASIS = /\btour(s|ing|ed)?\b|\bon the road\b/i;
const TAXONOMY_BASIS = /\b(off-)?west end\b|\bsubsidi[sz]ed\b|\bpre-transfer\b/i;
const WINDOW_DAYS = 60;

function parseDay(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return Number.isFinite(t) ? t : null;
}

/** True when a dated review falls outside this record's run (with a margin); undated reviews are not ruled out. */
function outsideRun(publishDate, show) {
  const p = parseDay(publishDate);
  if (p == null) return false;
  const start = parseDay(show.previewsStartDate) ?? parseDay(show.openingDate);
  const end = parseDay(show.closingDate);
  const day = 86400000;
  if (start != null && p < start - WINDOW_DAYS * day) return true;
  if (end != null && p > end + WINDOW_DAYS * day) return true;
  return false;
}

// Tour cities whose houses share London theatre names (the Lyceum in
// Sheffield, the Palace in Manchester, the Playhouse in Edinburgh). A reported
// venue naming one of these is another stop, whatever the theatre is called.
const OTHER_CITIES = [
  'sheffield', 'manchester', 'salford', 'birmingham', 'leeds', 'liverpool', 'edinburgh', 'glasgow',
  'aberdeen', 'dundee', 'bristol', 'bath', 'cardiff', 'swansea', 'belfast', 'dublin', 'nottingham',
  // Bare words that are also London names are given as the out-of-town
  // house instead: "york" is in "Duke of York's", "stoke" in Stoke Newington,
  // "cambridge" in the Cambridge Theatre, "oxford" in Oxford Street.
  'leicester', 'newcastle', 'sunderland', 'york theatre royal', 'grand opera house york', 'hull', 'bradford', 'blackpool', 'brighton',
  'southampton', 'plymouth', 'norwich', 'oxford playhouse', 'new theatre oxford', 'cambridge arts', 'milton keynes', 'stoke-on-trent', 'stoke on trent', 'wolverhampton',
  'coventry', 'canterbury', 'chichester', 'cheltenham', 'woking', 'wimbledon', 'richmond', 'bromley',
  'new york', 'broadway', 'chicago', 'toronto', 'sydney', 'melbourne', 'los angeles', 'boston',
];

/** Does the theatre the verifier says the critic attended name this record's venue? */
function reviewedAtOwnVenue(reviewedVenue, show) {
  if (!reviewedVenue || !show || !show.venue) return false;
  // "Sheffield's Lyceum" -> "sheffield lyceum" for the city check; venue
  // tokens drop apostrophes the same way ("Wyndham's" -> "wyndhams").
  const plain = v => normalizeForMatch(v).replace(/'s\b/g, '').replace(/'/g, '');
  const text = plain(reviewedVenue);
  const own = plain(show.venue);
  if (OTHER_CITIES.some(c => containsToken(text, c) && !containsToken(own, c))) return false;
  const textNoApos = normalizeForMatch(reviewedVenue).replace(/'/g, '');
  // The building's other names count too: reviews of a 2019 run say "Duke
  // of York's" for a record filed under its 2026 name, the Tom Stoppard
  // Theatre; "Trafalgar Studios" for the Trafalgar Theatre (lib/venue-aliases).
  const names = [show.venue, ...require('./venue-aliases').otherVenueNames(show.venue, show.category)];
  return names.some(n => venueTokens(n).some(t => containsToken(text, t) || containsToken(textNoApos, t)));
}

/**
 * @param {{wrongProduction: boolean, reasoning?: string, issues?: string[], reviewedVenue?: string|null}} cv
 * @param {object|null} show - shows.json record
 * @param {{publishDate?: string|null}} [opts]
 * @returns {{wrongProduction: boolean, tourStopCarveoutApplied: boolean}}
 */
function applyOwnVenueTourCarveout(cv, show, { publishDate } = {}) {
  const unchanged = { wrongProduction: !!(cv && cv.wrongProduction), tourStopCarveoutApplied: false };
  if (!cv || !cv.wrongProduction || !show) return unchanged;
  if (!reviewedAtOwnVenue(cv.reviewedVenue, show)) return unchanged;
  if (outsideRun(publishDate, show)) return unchanged;
  // Attended this record's venue, and not dated outside this run. A dated
  // review inside the run is this production whatever the objection. An
  // undated one could be an earlier staging at the same house, so it is
  // cleared only for the two objections that are about the record, not the
  // review: touring, and venue taxonomy ("a National Theatre production, not
  // the West End production at the Olivier"; "the Royal Court production,
  // not a West End one" on the Royal Court record).
  const basis = [cv.reasoning || '', ...(Array.isArray(cv.issues) ? cv.issues : [])].join(' ');
  const dated = parseDay(publishDate) != null;
  if (!dated && !TOUR_BASIS.test(basis) && !TAXONOMY_BASIS.test(basis)) return unchanged;
  return { wrongProduction: false, tourStopCarveoutApplied: true };
}

/**
 * Fields to persist on a review when the verifier applied the carve-out: the
 * rebuild's fullText tour scan reads allowTourSignal, not the CV verdict.
 * @returns {object} {} when nothing should change
 */
function tourStopAllowFields(cv, data) {
  if (!cv || !cv.tourStopCarveoutApplied || (data && data.allowTourSignal === true)) return {};
  return require('./contamination-allow-signal').contaminationAllowFields('tour',
    `own-venue tour stop: critic attended "${cv.reviewedVenue}"`);
}

module.exports = { applyOwnVenueTourCarveout, reviewedAtOwnVenue, outsideRun, tourStopAllowFields };
