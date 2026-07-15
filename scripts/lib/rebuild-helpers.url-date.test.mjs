// Unit test for extractDateFromUrl (scripts/lib/rebuild-helpers.js) — the
// canonical URL-date fallback shared by rebuild-all-reviews.js and the
// backfill scripts. Card: publishDate backfill + URL-date extraction
// fallback (88 dateless reviews on recent shows).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { extractDateFromUrl } = require('./rebuild-helpers.js');

test('WordPress-style /YYYY/MM/DD/', () => {
  // 2026 is in rebuild-helpers.js's TITLE_YEARS blocklist (a show title looks
  // like a year), so use 2025 here to exercise the pattern itself.
  const r = extractDateFromUrl('https://loureviews.blog/2025/07/14/some-show-review/');
  assert.equal(r.date, '2025-07-14');
  assert.equal(r.source, 'url-ymd');
});

test('Guardian word-month /YYYY/mon/DD', () => {
  const r = extractDateFromUrl('https://www.theguardian.com/stage/2026/jul/14/some-show-review');
  assert.equal(r.date, '2026-07-14');
  assert.equal(r.source, 'url-guardian');
});

test('BWW-style compact YYYYMMDD suffix', () => {
  const r = extractDateFromUrl('https://www.broadwayworld.com/article/Review-SHOW-20261014-20261014');
  assert.equal(r.date, '2026-10-14');
  assert.equal(r.source, 'url-compact');
});

test('dash YYYY-MM-DD in path', () => {
  const r = extractDateFromUrl('https://www.latimes.com/entertainment/story/2025-04-22/some-show-review');
  assert.equal(r.date, '2025-04-22');
  assert.equal(r.source, 'url-dash');
});

test('dash pattern rejects show-title years', () => {
  const r = extractDateFromUrl('https://example.com/reviews/1776-review');
  assert.equal(r, null);
});

test('blogspot year+month only', () => {
  const r = extractDateFromUrl('https://sometheaterblog.blogspot.com/2026/06/some-show-review.html');
  assert.equal(r.date, '2026-06');
  assert.equal(r.source, 'url-blogspot-ym');
});

// --- Talkin' Broadway /ob/ pattern (the actual gap this card closes) ---

test('TB /ob/MM_DD_YY.html — two-digit month, recent year', () => {
  const r = extractDateFromUrl('https://www.talkinbroadway.com/ob/07_13_26.html');
  assert.equal(r.date, '2026-07-13');
  assert.equal(r.source, 'url-tb-ob');
});

test('TB /page/ob/MM_DD_YY.html — the /page/ prefix variant', () => {
  const r = extractDateFromUrl('https://www.talkinbroadway.com/page/ob/02_24_26.html');
  assert.equal(r.date, '2026-02-24');
  assert.equal(r.source, 'url-tb-ob');
});

test('TB single-digit month and day', () => {
  const r = extractDateFromUrl('http://www.talkinbroadway.com/page/ob/5_31_16.html');
  assert.equal(r.date, '2016-05-31');
});

test('TB trailing letter disambiguator (same-day multi-review)', () => {
  const r = extractDateFromUrl('https://www.talkinbroadway.com/page/ob/02_08_24b.html');
  assert.equal(r.date, '2024-02-08');
});

test('TB two-digit year pivot: low YY -> 20YY, high YY -> 19YY', () => {
  const recent = extractDateFromUrl('https://www.talkinbroadway.com/ob/02_25_08.html');
  assert.equal(recent.date, '2008-02-25');
  const old = extractDateFromUrl('https://www.talkinbroadway.com/ob/07_15_96.html');
  assert.equal(old.date, '1996-07-15');
});

test('TB pattern rejects invalid calendar dates', () => {
  const r = extractDateFromUrl('https://www.talkinbroadway.com/ob/02_30_26.html');
  assert.equal(r, null);
});

test('non-TB domain with an /ob/-shaped path is NOT matched (domain-scoped)', () => {
  const r = extractDateFromUrl('https://example.com/ob/07_13_26.html');
  assert.equal(r, null);
});

test('TB /page/world/ URLs (no day-level date) fall through to null', () => {
  const r = extractDateFromUrl('https://www.talkinbroadway.com/page/world/Cats2016.html');
  assert.equal(r, null);
});

test('no URL returns null', () => {
  assert.equal(extractDateFromUrl(null), null);
  assert.equal(extractDateFromUrl(''), null);
});

test('URL with no recognizable date pattern returns null', () => {
  const r = extractDateFromUrl('https://vulture.com/some-show-review');
  assert.equal(r, null);
});
