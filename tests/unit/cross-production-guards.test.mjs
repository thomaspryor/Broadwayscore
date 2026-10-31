import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isEvergreenListingUrl, contentMatchesFiledUnderVenue } =
  require('../../scripts/lib/cross-production-guards.js');
const { venueSlug } = require('../../scripts/lib/venue-classification.js');

// ── isEvergreenListingUrl ─────────────────────────────────────────────────────
test('isBlockedReviewUrl: /tickets/ section with a singular review slug is allowed, listings stay blocked (BRO-5876)', () => {
  const { isBlockedReviewUrl } = require('../../scripts/lib/domain-filters.js');
  assert.equal(isBlockedReviewUrl('https://www.radiotimes.com/going-out/tickets/hercules-musical-review/'), false);
  assert.equal(isBlockedReviewUrl('https://www.radiotimes.com/going-out/tickets/hercules-musical/'), true);
  assert.equal(isBlockedReviewUrl('https://www.radiotimes.com/going-out/tickets/hercules-musical-reviews/'), true);
  assert.equal(isBlockedReviewUrl('https://www.standard.co.uk/go/london/mamma-mia-musical-theatre-tickets-in-london'), true);
  assert.equal(isBlockedReviewUrl('https://example.com/buy-tickets/review'), true);
});

test('isEvergreenListingUrl: singular "review" headline slugs containing tickets are not listings (BRO-5876)', () => {
  assert.equal(isEvergreenListingUrl('https://www.radiotimes.com/going-out/tickets/hercules-musical-review/'), false);
  assert.equal(isEvergreenListingUrl('https://www.express.co.uk/entertainment/theatre/1769203/operation-mincemeat-musical-review-London-2023-Fortune-theatre-dates-tickets'), false);
  assert.equal(isEvergreenListingUrl('https://www.digitalspy.com/theatre/a1/hercules-review-buy-tickets/'), false);
  assert.equal(isEvergreenListingUrl('https://www.timeout.com/london/theatre/hamilton-tickets-and-review'), false);
  // roundups / true listings stay blocked
  assert.equal(isEvergreenListingUrl('https://www.express.co.uk/entertainment/theatre/avenue-q-reviews-tickets'), true);
  assert.equal(isEvergreenListingUrl('https://www.timeout.com/newyork/theater/tickets-reviews-and-video'), true);
  assert.equal(isEvergreenListingUrl('https://venue.com/tickets/?utm=review'), true);
  assert.equal(isEvergreenListingUrl('https://venue.com/review/buy-tickets'), true);
  assert.equal(isEvergreenListingUrl('https://review.example.com/tickets/'), true);
});

test('isEvergreenListingUrl: an outlet /reviews/<slug> section counts as a review headline, a plural slug or /tickets/ segment does not (BRO-5876)', () => {
  // Paul Taylor's I'm Not Running (Independent): the only review word is the section.
  assert.equal(isEvergreenListingUrl('https://www.independent.co.uk/arts-entertainment/theatre-dance/reviews/im-not-running-dave-hare-play-national-theatre-cast-tickets-last-night-a8576961.html'), false);
  assert.equal(isEvergreenListingUrl('https://www.express.co.uk/entertainment/theatre/1920772/starlight-express-reviews-tickets-london-2024'), true);
  assert.equal(isEvergreenListingUrl('https://example.com/reviews/buy-tickets'), true);
  assert.equal(isEvergreenListingUrl('https://example.com/shows/x-tickets?from=/reviews/'), true);
  // A /tickets/ segment under /reviews/ is a hub page, not a review.
  assert.equal(isEvergreenListingUrl('https://www.example.com/reviews/tickets/'), true);
  assert.equal(isEvergreenListingUrl('https://www.londontheatre.co.uk/reviews/tickets/x'), true);
});

test('evergreen: tickets/listing pages are detected (date heuristic must skip them)', () => {
  assert.equal(isEvergreenListingUrl('https://www.britishtheatre.com/nl/shows/titanique-musical-tickets'), true);
  assert.equal(isEvergreenListingUrl('https://nymag.com/listings/theater/the_phantom_of_the_opera/'), true);
  assert.equal(isEvergreenListingUrl('https://example.com/tickets/'), true);
  assert.equal(isEvergreenListingUrl('https://venue.com/whats-on/wicked'), true);
  assert.equal(isEvergreenListingUrl('https://www.londonmumsmagazine.com/whats-on/review-holy-fool-at-park-theatre-a-powerful-story/'), false);
  assert.equal(isEvergreenListingUrl('https://venue.com/whats-on/wicked?utm_campaign=reviews'), true);
  assert.equal(isEvergreenListingUrl('https://venue.com/whats-on/wicked#reviews'), true);
  assert.equal(isEvergreenListingUrl('https://www.londonmumsmagazine.com/whats-on/million-dollar-quartet-preview-your-cheat-sheet/'), true);
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
