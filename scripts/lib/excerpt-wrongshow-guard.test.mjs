import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { shouldSuppressExcerptOnlyWrongShow: g, urlSlugNamesShow } = require('./excerpt-wrongshow-guard.js');

const URL_OK = 'https://www.newyorktheatreguide.com/reviews/two-girls-off-broadway-review';
const base = { rejection: 'wrong_show', scoredTextType: 'excerpt', showTitle: 'Two Girls', fileData: { url: URL_OK, fullText: '' } };

test('BRO-5785 real case: excerpt-only wrong_show, slug names Two Girls -> suppressed', () => {
  assert.deepEqual(g(base), { suppress: true, reason: 'excerpt_only_wrong_show_url_names_show' });
});
test('fullText present -> verdict stands', () => {
  assert.equal(g({ ...base, fileData: { url: URL_OK, fullText: 'x'.repeat(500) } }).suppress, false);
});
test('fullText was the judged text -> verdict stands', () => {
  assert.equal(g({ ...base, scoredTextType: 'fullText' }).suppress, false);
});
test('slug does not name the show -> verdict stands', () => {
  assert.equal(g({ ...base, fileData: { url: 'https://x.com/reviews/school-girls-review', fullText: '' } }).suppress, false);
});
test('other rejection types are untouched', () => {
  assert.equal(g({ ...base, rejection: 'not_a_review' }).suppress, false);
  assert.equal(g({ ...base, rejection: 'wrong_production' }).suppress, false);
});
test('missing url/title is safe', () => {
  assert.equal(g({ ...base, fileData: {} }).suppress, false);
  assert.equal(g({ ...base, showTitle: undefined }).suppress, false);
  assert.equal(urlSlugNamesShow('not a url', 'Two Girls'), false);
});
test('title must open the last slug segment (review feedback)', () => {
  assert.equal(urlSlugNamesShow('https://x.com/r/school-girls-review', 'Girls'), false);
  assert.equal(urlSlugNamesShow('https://x.com/roundabout-theatre-company-gala', 'Company'), false);
  assert.equal(urlSlugNamesShow('https://x.com/romeo-and-juliet-review', '&Juliet'), false);
  assert.equal(urlSlugNamesShow('https://x.com/r/twogirlsish', 'Two Girls'), false);
});
test('leading "the" and subtitled slugs', () => {
  assert.equal(urlSlugNamesShow('https://x.com/r/lion-king-review', 'The Lion King'), true);
  assert.equal(urlSlugNamesShow('https://x.com/r/the-lion-king-review', 'Lion King'), true);
});
test('fullText 99 vs 100 chars', () => {
  assert.equal(g({ ...base, fileData: { url: URL_OK, fullText: 'x'.repeat(99) } }).suppress, true);
  assert.equal(g({ ...base, fileData: { url: URL_OK, fullText: 'x'.repeat(100) } }).suppress, false);
});

// BRO-7044: Time Out's Unbelievers review was rejected not_a_review on a 303-char premise blurb.
const { shouldSuppressExcerptOnlyNotAReview: n, urlSlugIsReviewOfShow } = require('./excerpt-wrongshow-guard.js');
const TO_URL = 'https://www.timeout.com/newyork/theater/the-unbelievers-off-broadway-review-lauren-ambrose';
const nbase = { rejection: 'not_a_review', scoredTextType: 'excerpt', showTitle: 'The Unbelievers', fileData: { url: TO_URL, fullText: null } };

test('BRO-7044 real case: excerpt-only not_a_review on a <show>-review slug -> suppressed', () => {
  assert.deepEqual(n(nbase), { suppress: true, reason: 'excerpt_only_not_a_review_url_is_review_slug' });
});
test('BRO-7044: fullText judged, or non-review slug, or other rejection -> verdict stands', () => {
  assert.equal(n({ ...nbase, scoredTextType: 'fullText' }).suppress, false);
  assert.equal(n({ ...nbase, fileData: { url: TO_URL, fullText: 'x'.repeat(500) } }).suppress, false);
  assert.equal(n({ ...nbase, fileData: { url: 'https://x.com/the-unbelievers-cast-and-tickets', fullText: null } }).suppress, false);
  assert.equal(n({ ...nbase, fileData: { url: 'https://x.com/a-different-show-review', fullText: null } }).suppress, false);
  assert.equal(n({ ...nbase, rejection: 'wrong_show' }).suppress, false);
  assert.equal(n({ ...nbase, showTitle: undefined }).suppress, false);
  assert.equal(urlSlugIsReviewOfShow('not a url', 'The Unbelievers'), false);
});
