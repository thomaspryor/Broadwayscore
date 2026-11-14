/**
 * genre-classification.js — discovery-side genre inference + the non-theatrical
 * policy list. CommonJS mirror of the policy in src/lib/genre.ts (which is
 * browser-bundled and can't be require()'d from a plain-node discovery script).
 * tests/unit/genre-policy-parity.test.mjs fails if NON_THEATRICAL_GENRES drifts
 * between the two files.
 *
 * Genre is a show's PERFORMANCE TYPE beyond play/musical/special: dance, magic,
 * comedy (stand-up), cabaret, concert, circus. These keep critic scores but live
 * on the Off-West End hub, not the West End plays/musicals listing.
 *
 * classifyGenre() is intentionally CONSERVATIVE — it only returns a genre when a
 * venue or a high-confidence title/description signal makes it unambiguous, and
 * returns null otherwise (a play titled "The Dancer" must NOT become dance). An
 * existing manual genre on the show always wins.
 */

'use strict';

const NON_THEATRICAL_GENRES = ['dance', 'magic', 'comedy', 'cabaret', 'concert', 'circus'];
const NON_THEATRICAL_SET = new Set(NON_THEATRICAL_GENRES);

function isNonTheatricalGenre(genre) {
  return !!genre && NON_THEATRICAL_SET.has(genre);
}

/**
 * Genre overrides venue for category too: a non-theatrical show (dance/magic/
 * comedy/cabaret/concert/circus) belongs on the Off-West End hub even when it
 * plays a West End venue (e.g. dance at Sadler's Wells) — see src/lib/genre.ts.
 * Single source of truth for both discover-new-shows.js (apply at intake) and
 * validate-data.js's validateVenueCategory (CI backstop) so the two can't
 * drift — the "§6 category reverts" bug this fixes was exactly that drift.
 */
function applyGenreCategoryOverride(category, genre) {
  return (isNonTheatricalGenre(genre) && category === 'west-end') ? 'off-west-end' : category;
}

// Venues that are unambiguously dance houses — anything programmed here is dance
// unless an explicit manual genre says otherwise. (Regent's Park, the Coliseum,
// the Globe etc. are deliberately NOT here: they programme plays/musicals/opera
// too, so a venue signal alone would misclassify.)
const DANCE_VENUES = new Set([
  "sadler's wells",
  'sadlers wells',
  'peacock theatre',
  'peacock',
]);

// High-confidence title/description patterns. Deliberately NOT bare genre words:
// "Cabaret" (the Kander & Ebb musical), "Magic Mike" (a dance show), and plays
// that are "comedies" would all false-positive. Each pattern needs a specific,
// unambiguous performance signal. Order matters: first match wins.
const GENRE_PATTERNS = [
  { genre: 'dance', re: /\b(ballet|dance theater|dance theatre|tap dance|rambert|alvin ailey|matthew bourne|akram khan|english national ballet|royal ballet|tango)\b/i },
  // NOT bare "magic" (Magic Mike). Named magic acts + explicit "magic show".
  { genre: 'magic', re: /\b(illusionist|magic show|derren brown|now you see me)\b/i },
  { genre: 'circus', re: /\b(circus|cirque|acrobat)\b/i },
  // NOT bare "cabaret" (the musical). Burlesque/drag + the tribute-act phrasing.
  { genre: 'cabaret', re: /\b(burlesque|drag (?:show|brunch))\b|:\s*a tribute\b/i },
  { genre: 'concert', re: /\bin concert\b|\blive in concert\b/i },
  // Stand-up comedy is the most false-positive-prone (many plays are "comedies"),
  // so require explicit stand-up / live-comedy phrasing, NOT the bare word and
  // NOT "an evening with" (matches talks/Q&As/literary events).
  { genre: 'comedy', re: /\b(stand-?up|live comedy|comedy special)\b/i },
];

// A venue-derived dance classification is suppressed when the title says the show
// is really a musical or a concert (dance houses occasionally host jukebox
// musicals / gig-theatre — e.g. "...The Chaka Khan Musical" at the Peacock).
const NOT_DANCE_DESPITE_VENUE = /\b(musical|in concert|the concert|gig theatre)\b/i;

/**
 * Infer a show's genre, or null when no high-confidence signal exists.
 * @param {object} show - needs at least { title, venue, description }.
 * @returns {string|null}
 */
function classifyGenre(show) {
  if (!show) return null;
  if (show.genre) return show.genre; // manual genre is authoritative

  const hay = `${show.title || ''} ${show.description || ''}`;

  // Specific title/description signals win first (a named dance company at a
  // non-dance venue should still classify; a musical at a dance house should not).
  for (const { genre, re } of GENRE_PATTERNS) {
    if (re.test(hay)) return genre;
  }

  const venue = (show.venue || '').trim().toLowerCase();
  if (DANCE_VENUES.has(venue) && !NOT_DANCE_DESPITE_VENUE.test(hay)) return 'dance';

  return null;
}

module.exports = {
  NON_THEATRICAL_GENRES,
  isNonTheatricalGenre,
  applyGenreCategoryOverride,
  classifyGenre,
  DANCE_VENUES,
};
