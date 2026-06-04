import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { heuristicClassify } = require('../../scripts/lib/non-review-patterns.js');

// The embarrassing class: wrong-page newspaper OCR scored as a review.
test('flags an LA Times weather page (the shipped 88-score bug)', () => {
  const t = 'SATURDAY, MARCH 8, 2008 LOS ANGELES TIMES CALIFORNIA THE WEATHER VENTURA COUNTY Ojai 75/40 Santa Barbara 67/44 Five-day forecast low temperatures sunrise 6:13a sunset 5:56p tide table high low feet';
  const r = heuristicClassify(t);
  assert.ok(r && r.isNonReview && r.confidence === 'high', 'weather page must be high-confidence non-review');
  assert.equal(r.type, 'weather_page');
});

test('flags a Chicago Tribune sports scoreboard (the shipped 72-score bug)', () => {
  const t = 'SCOREBOARD D 11 MONDAY, OCTOBER 19, 2009 | SECTION 2 | SPORTS | CHICAGO TRIBUNE FOR EXPANDED STATISTICS Joliet at Homewood-Flossmoor Sandburg at Lockport box score standings';
  const r = heuristicClassify(t);
  assert.ok(r && r.isNonReview && r.confidence === 'high', 'sports page must be high-confidence non-review');
  assert.equal(r.type, 'sports_page');
});

// Listings words (Classifieds/Crossword/Horoscope) are NOT gated: they false-
// positive on newspaper nav bars OCR'd alongside real reviews (57 FPs across the
// corpus). Only weather/sports page signals are definitive.
test('does NOT flag newspaper nav-bar words (Classifieds/Crossword) — they FP on real OCR', () => {
  const navOcr = 'The production is thrilling and the direction masterful. ... Classifieds Crossword Horoscope Subscribe';
  assert.equal(heuristicClassify(navOcr), null);
});

test('does NOT flag a genuine theater review (no false positive)', () => {
  const review = 'Monty Python\'s Spamalot, directed by Mike Nichols, opened last night at the Shubert Theatre. The production is amusing, agreeable, forgettable. Tim Curry and Hank Azaria are thrilling, and the staging feels brisk. A standing ovation at the curtain call.';
  assert.equal(heuristicClassify(review), null, 'a real review must not be flagged');
});

test('does NOT flag a review that merely mentions weather or sports in passing', () => {
  const review = 'The staging is stunning. Set on a sweltering July night, the production opened this week to a standing ovation; the direction is masterful and the performances riveting.';
  assert.equal(heuristicClassify(review), null);
});
