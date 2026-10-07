import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isEvergreenListingUrl, contentMatchesFiledUnderVenue } =
  require('../../scripts/lib/cross-production-guards.js');
const { venueSlug } = require('../../scripts/lib/venue-classification.js');

// ── isEvergreenListingUrl ─────────────────────────────────────────────────────
test('evergreen: tickets/listing pages are detected (date heuristic must skip them)', () => {
  assert.equal(isEvergreenListingUrl('https://www.britishtheatre.com/nl/shows/titanique-musical-tickets'), true);
  assert.equal(isEvergreenListingUrl('https://nymag.com/listings/theater/the_phantom_of_the_opera/'), true);
  assert.equal(isEvergreenListingUrl('https://example.com/tickets/'), true);
  assert.equal(isEvergreenListingUrl('https://venue.com/whats-on/wicked'), true);
  assert.equal(isEvergreenListingUrl('https://venue.com/buy-tickets'), true);
});

test('evergreen: westendtheatre.com show pages are listings even without a -tickets suffix', () => {
  // 2026-08-04: three WET listing pages sat as unflagged "reviews" on NYSM /
  // Dinosaur World / Crocodile. The -tickets suffix is inconsistent on WET.
  assert.equal(isEvergreenListingUrl('https://www.westendtheatre.com/56719/shows/dinosaur-world-live/'), true);
  assert.equal(isEvergreenListingUrl('https://www.westendtheatre.com/346267/shows/now-you-see-me-live-tickets/'), true);
  assert.equal(isEvergreenListingUrl('https://www.westendtheatre.com/208183/shows/the-enormous-crocodile-the-musical-tickets/'), true);
});

test('evergreen: real dated review URLs are NOT flagged', () => {
  assert.equal(isEvergreenListingUrl('https://www.nytimes.com/2024/04/12/theater/titanique-review.html'), false);
  assert.equal(isEvergreenListingUrl('https://www.thestage.co.uk/reviews/giant-review-royal-court'), false);
  // westendtheatre.com NEWS articles (no numeric-id /shows/ path) stay unflagged
  assert.equal(isEvergreenListingUrl('https://www.westendtheatre.com/352331/news/dinosaur-world-live-to-play-the-troubadour-wembley-park-theatre-in-london/'), false);
  assert.equal(isEvergreenListingUrl(''), false);
  assert.equal(isEvergreenListingUrl(null), false);
});

// ── contentMatchesFiledUnderVenue (the body-only contract) ────────────────────
test('venue-match: a review whose BODY names the filed-under venue is matched', () => {
  const review = { fullText: 'The Olivier-winning comedy sails into the Criterion Theatre for a riotous night.' };
  assert.equal(contentMatchesFiledUnderVenue(review, 'criterion'), true);
});

test('venue-match: REGRESSION — must use fullText ONLY, never the venue metadata field', () => {
  // The venue field is auto-populated from the filed-under show at ingestion.
  // A genuine cross-production misfile (2019 NY Post Broadway review wrongly
  // filed under beetlejuice-west-end-2026) carries venue="Prince Edward Theatre"
  // but its BODY never names that venue. Matching the metadata field would
  // tautologically suppress this real detection — the bug fixed 2026-06-21.
  const misfiled = {
    venue: 'Prince Edward Theatre',
    fullText: 'Beetlejuice the musical is a coke-snorting, fourth-wall-breaking spectacle that opened on Broadway in 2019.',
  };
  assert.equal(contentMatchesFiledUnderVenue(misfiled, 'prince-edward'), false,
    'venue-field-only match must NOT suppress a review whose body does not name the venue');
});

test('venue-match: null slug or empty review never matches', () => {
  assert.equal(contentMatchesFiledUnderVenue({ fullText: 'anything' }, null), false);
  assert.equal(contentMatchesFiledUnderVenue({}, 'criterion'), false);
  assert.equal(contentMatchesFiledUnderVenue(null, 'criterion'), false);
});

// ── task #783: venueSlug(prod.venue) pairing must survive diacritics ──────────
test('venue-match: an accented venue slug matches a body that spells the venue with its accent', () => {
  const slug = venueSlug('Noël Coward Theatre');
  const review = { fullText: 'The revival storms into the Noël Coward Theatre this spring.' };
  assert.equal(contentMatchesFiledUnderVenue(review, slug), true);
});

test('venue-match: an accented venue slug ALSO matches a body that spells the venue in plain ASCII', () => {
  const slug = venueSlug('Noël Coward Theatre');
  const review = { fullText: 'Written entirely in ASCII: Noel Coward Theatre welcomes the cast.' };
  assert.equal(contentMatchesFiledUnderVenue(review, slug), true);
});
