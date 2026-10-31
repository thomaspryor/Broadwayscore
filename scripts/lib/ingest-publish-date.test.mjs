// ingest-publish-date.js: the publish date ingest-review-from-url.js stores
// (BRO-6588). Page metadata first, then the collector's body-byline fallback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveIngestPublishDate } = require('./ingest-publish-date.js');

const URL_ = 'https://www.thewrap.com/a-few-good-men-broadway-review-sean-hayes/';
const body = (s) => `${s} ${'The production holds the courtroom tension well. '.repeat(10)}`;

test('a page whose JSON-LD has datePublished fills publishDate', () => {
  const html = `<html><head><script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org', '@type': 'NewsArticle', headline: 'Review', datePublished: '2026-10-29T20:00:00-04:00',
  })}</script></head><body><p>x</p></body></html>`;
  const r = resolveIngestPublishDate({ html, url: URL_, text: body('x') });
  assert.equal(r.from, 'page');
  assert.match(String(r.publishDate), /^2026-10-29/);
});

test('an explicit --publish-date wins over the page', () => {
  const r = resolveIngestPublishDate({ publishDateArg: '2026-10-30', html: '<html></html>', url: URL_, text: '' });
  assert.equal(r.publishDate, '2026-10-30');
  assert.equal(r.from, 'arg');
});

test('no page date: the body byline fills it, marked text-regex', () => {
  const r = resolveIngestPublishDate({ html: '<html><body></body></html>', url: URL_, text: body('By Critic | October 29, 2026 @ 8:00 PM') });
  assert.equal(r.from, 'text');
  assert.equal(r.dateSource, 'text-regex');
  assert.match(String(r.publishDate), /^2026-10-29/);
});

test('a body date that conflicts with the url date is not used', () => {
  const r = resolveIngestPublishDate({ html: '<html></html>', url: 'https://example.com/2024/03/02/show-review/', text: body('October 29, 2026') });
  assert.equal(r.publishDate, null);
});

test('nothing to go on gives null', () => {
  const r = resolveIngestPublishDate({ html: '<html></html>', url: URL_, text: 'short' });
  assert.equal(r.publishDate, null);
});
