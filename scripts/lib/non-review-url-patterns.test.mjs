// non-review-url-patterns.js — canonical not-a-review host/path patterns
// shared between audit-show-review-gap.js's isReviewUrl() and the S5
// adversarial probe's classifyNonReviewUrl() (task #907 ship-check finding:
// extracted so the two callers can't drift apart).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { namedNonReviewReason, NAMED_NON_REVIEW_URL_PATTERNS } = require('./non-review-url-patterns.js');

test('namedNonReviewReason: ticketing reseller hosts are named', () => {
  assert.equal(namedNonReviewReason('https://www.newyorkcitytheatre.com/some-show'), 'ticketing-reseller');
  assert.equal(namedNonReviewReason('https://newbrunswicktheater.com/tickets'), 'ticketing-reseller');
  assert.equal(namedNonReviewReason('https://www.broadway.com/shows/a-walk-on-the-moon/event/21764799/'), 'ticketing-reseller');
});

test('namedNonReviewReason: venue production pages are named', () => {
  assert.equal(namedNonReviewReason('https://www.nationaltheatre.org.uk/productions/the-car-man'), 'venue-production-page');
  assert.equal(namedNonReviewReason('https://www.theatermania.com/shows/new-york-city-theater/x_1832919/'), 'venue-production-page');
});

test('namedNonReviewReason: event listing pages are named', () => {
  assert.equal(namedNonReviewReason('https://middlesexcountyculture.com/event/the-car-man/'), 'event-listing');
});

test('namedNonReviewReason: host+path pairs only exclude the specific path, not the whole host', () => {
  // londontheatre.co.uk publishes real reviews under /reviews/ — only /show/NNNN is excluded.
  assert.equal(namedNonReviewReason('https://www.londontheatre.co.uk/show/1234/the-car-man'), 'ticketing-listing');
  assert.equal(namedNonReviewReason('https://www.londontheatre.co.uk/reviews/the-car-man'), null);
  // theatermania publishes real reviews under /news/review-.../ — only /shows/ is excluded.
  assert.equal(namedNonReviewReason('https://www.theatermania.com/news/review-camping-a-romantic-tragedy_1842335/'), null);
});

test('namedNonReviewReason: an ordinary outlet URL is not classified', () => {
  assert.equal(namedNonReviewReason('https://theartsdesk.com/new-reviews/frank-sinatra-review'), null);
});

test('namedNonReviewReason: an unparseable URL returns null, never throws', () => {
  assert.equal(namedNonReviewReason('not-a-url'), null);
  assert.equal(namedNonReviewReason(''), null);
  assert.equal(namedNonReviewReason(null), null);
});

test('NAMED_NON_REVIEW_URL_PATTERNS: every entry has a host regex and a reason string', () => {
  for (const p of NAMED_NON_REVIEW_URL_PATTERNS) {
    assert.ok(p.host instanceof RegExp, `missing host regex: ${JSON.stringify(p)}`);
    assert.equal(typeof p.reason, 'string');
    assert.ok(p.reason.length > 0);
    if (p.path) assert.ok(p.path instanceof RegExp);
  }
});
