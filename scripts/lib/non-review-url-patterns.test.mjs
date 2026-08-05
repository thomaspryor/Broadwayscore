// non-review-url-patterns.js — canonical not-a-review host/path patterns
// shared between audit-show-review-gap.js's isReviewUrl() and the S5
// adversarial probe's classifyNonReviewUrl() (task #907 ship-check finding:
// extracted so the two callers can't drift apart).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { namedNonReviewReason, NAMED_NON_REVIEW_URL_PATTERNS, NON_REVIEW_HOST_PATTERNS, ALLOWED_ORG_HOSTS } = require('./non-review-url-patterns.js');

// Mirrors audit-show-review-gap.js's registrableHost() collapse for a plain
// host-pattern check (task #71 residual-gap triage additions) — including its
// multi-part public-suffix list, so a .co.uk host collapses to 3 labels, not 2.
const MULTIPART_SUFFIXES = ['co.uk', 'org.uk', 'me.uk', 'ac.uk', 'gov.uk', 'com.au', 'net.au', 'org.au', 'co.nz', 'co.za', 'com.br'];
function isHostBlocked(url) {
  let host;
  try { host = new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return false; }
  const parts = host.split('.').filter(Boolean);
  const keep = MULTIPART_SUFFIXES.some(s => host.endsWith('.' + s)) ? 3 : 2;
  const registrable = parts.length > keep ? parts.slice(-keep).join('.') : host;
  return NON_REVIEW_HOST_PATTERNS.some(rx => rx.test(registrable)) && !ALLOWED_ORG_HOSTS.has(registrable);
}

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

test('NON_REVIEW_HOST_PATTERNS: page-asset chaff is blocked (task #71)', () => {
  // Measured in data/audit/show-review-gap.json's "missing" lists across
  // ~150 audited shows: fonts/CDN/maps/forms embedded in an aggregator
  // article's HTML.
  assert.equal(isHostBlocked('https://dalyklerwhmui.cloudfront.net'), true);
  assert.equal(isHostBlocked('https://fonts.gstatic.com'), true);
  assert.equal(isHostBlocked('https://fonts.googleapis.com/css2'), true);
  assert.equal(isHostBlocked('https://maps.google.com/'), true);
  assert.equal(isHostBlocked('https://docs.google.com/forms/d/e/abc/viewform'), true);
  assert.equal(isHostBlocked('https://www.todaytixgroup.com/careers'), true);
  // A real outlet is never blocked by this wave.
  assert.equal(isHostBlocked('https://www.nytimes.com/2026/01/01/theater/some-review.html'), false);
  // show-score.com is deliberately NOT blocked despite its own catalog links
  // leaking through the same way — coverage-adversarial-probe.js's
  // onDiskByUrlFor() depends on isReviewUrl() to index legitimately-captured
  // Show Score star-stub files by URL (see aggregator-domains.js).
  assert.equal(isHostBlocked('https://www.show-score.com/off-broadway-shows/bone-wars'), false);
});

test('NON_REVIEW_HOST_PATTERNS: UK ticketing/tourism-listing chaff is blocked (task #71 fifth wave)', () => {
  assert.equal(isHostBlocked('https://securepubads.g.doubleclick.net/pagead/managed/dict/m1/gpt'), true);
  assert.equal(isHostBlocked('https://www.showify.uk/shows/dog-man-the-musical'), true);
  assert.equal(isHostBlocked('https://www.showpass.com/dog-man-the-musical-affp3/'), true);
  assert.equal(isHostBlocked('https://showtours.co.uk/book/dog-man-the-musical-london/'), true);
  assert.equal(isHostBlocked('https://www.bookitplease.com/shows/united-kingdom/dog-man-6046'), true);
  assert.equal(isHostBlocked('https://www.visitlondon.com/things-to-do/event/51157787-dog-man'), true);
  // londontheatredirect.com is deliberately NOT blocked — it also publishes
  // /news/*-review posts alongside its ticketing pages.
  assert.equal(isHostBlocked('https://www.londontheatredirect.com/news/oh-mary-review'), false);
  // southlondon.co.uk is ALSO deliberately NOT blocked — it's a registered
  // Tier 4 outlet ("south-london") with real reviews under /lifestyle/review-*;
  // its /area/ listing pages are a different section of the same site.
  assert.equal(isHostBlocked('https://southlondon.co.uk/area/southwark/dog-man-the-musical/'), false);
  assert.equal(isHostBlocked('https://southlondon.co.uk/lifestyle/review-cyrano-de-bergerac-at-noel-coward-theatre/'), false);
});

test('NAMED_NON_REVIEW_URL_PATTERNS: every entry has a host regex and a reason string', () => {
  for (const p of NAMED_NON_REVIEW_URL_PATTERNS) {
    assert.ok(p.host instanceof RegExp, `missing host regex: ${JSON.stringify(p)}`);
    assert.equal(typeof p.reason, 'string');
    assert.ok(p.reason.length > 0);
    if (p.path) assert.ok(p.path instanceof RegExp);
  }
});
