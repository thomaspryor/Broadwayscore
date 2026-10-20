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
