// BRO-5859: Wayback recovery stored archived NYT texts without reading the
// archived page's date. Requires the real helper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { fillPublishDateFromHtml, waybackTimestampDate } = require('./fill-publish-date-from-html.js');

const URL = 'https://www.nytimes.com/2023/09/22/theater/vanya-andrew-scott.html';
const page = (iso) => `<html><head><meta property="article:published_time" content="${iso}"></head><body><p>x</p></body></html>`;

test('fills an undated record from article:published_time and stamps html-archive', () => {
  const d = { url: URL };
  assert.equal(fillPublishDateFromHtml(d, page('2023-09-22T14:00:00-04:00'), { source: 'html-archive' }), '2023-09-22');
  assert.equal(d.publishDate, '2023-09-22');
  assert.equal(d.dateSource, 'html-archive');
});

test('never overwrites a stored date and ignores a page without date metadata', () => {
  const dated = { url: URL, publishDate: '2023-09-21' };
  assert.equal(fillPublishDateFromHtml(dated, page('2023-09-22T14:00:00-04:00')), null);
  assert.equal(dated.publishDate, '2023-09-21');
  const bare = { url: URL };
  assert.equal(fillPublishDateFromHtml(bare, '<html><body><p>no date</p></body></html>'), null);
  assert.equal('publishDate' in bare, false);
});

test('the URL path date is never used', () => {
  const d = { url: URL };
  assert.equal(fillPublishDateFromHtml(d, '<html><head><title>Vanya</title></head></html>', { url: URL }), null);
  assert.equal(d.publishDate, undefined);
});

test('a date after the snapshot day is refused', () => {
  const d = { url: URL };
  assert.equal(fillPublishDateFromHtml(d, page('2024-01-05T10:00:00-05:00'), { notAfter: waybackTimestampDate('20231001120000') }), null);
  assert.equal(waybackTimestampDate('20251009122353'), '2025-10-09');
  assert.equal(waybackTimestampDate(undefined), null);
});
