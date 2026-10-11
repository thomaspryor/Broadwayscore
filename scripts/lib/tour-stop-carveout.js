'use strict';

/**
 * Own-venue tour-stop carve-out for content verification (BRO-4884).
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
 */

const { venueTokens, containsToken, normalizeForMatch } = require('./creative-team-verify');

const TOUR_BASIS = /\btour(s|ing|ed)?\b|\bon the road\b/i;
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
  'leicester', 'newcastle', 'sunderland', 'york', 'hull', 'bradford', 'blackpool', 'brighton',
  'southampton', 'plymouth', 'norwich', 'oxford', 'cambridge', 'milton keynes', 'stoke', 'wolverhampton',
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
  return venueTokens(show.venue).some(t => containsToken(text, t) || containsToken(textNoApos, t));
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
  const basis = [cv.reasoning || '', ...(Array.isArray(cv.issues) ? cv.issues : [])].join(' ');
  if (!TOUR_BASIS.test(basis)) return unchanged;
  if (!reviewedAtOwnVenue(cv.reviewedVenue, show)) return unchanged;
  if (outsideRun(publishDate, show)) return unchanged;
  return { wrongProduction: false, tourStopCarveoutApplied: true };
}

module.exports = { applyOwnVenueTourCarveout, reviewedAtOwnVenue, outsideRun };
