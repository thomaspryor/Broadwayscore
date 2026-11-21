/**
 * resolve-outlet-from-url.test.mjs — host-to-outlet resolution edge cases.
 *
 * BRO-5289: AP wire pages on a partner newspaper's domain
 * (online.wsj.com/article/AP<32 hex>.html) are AP's own review, so the host
 * must not file them under WSJ. Real WSJ article URLs still resolve to wsj.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveOutletFromUrl } = require('./review-normalization.js');

const AP_ID = 'AP216f8806ddad4b8b9837a6702e4c1a2b';

test('AP wire page on online.wsj.com resolves to null, not wsj', () => {
  assert.equal(resolveOutletFromUrl(`http://online.wsj.com/article/${AP_ID}.html`), null);
});

test('AP wire id match is case-insensitive and ignores query strings', () => {
  assert.equal(resolveOutletFromUrl(`https://online.wsj.com/article/${AP_ID.toUpperCase().replace(/^AP/, 'ap')}.html?mod=x`), null);
});

test('AP wire id on wsj.com with www still resolves to null', () => {
  assert.equal(resolveOutletFromUrl(`https://www.wsj.com/article/${AP_ID}.html`), null);
});

test('real wsj.com/articles URL resolves to wsj', () => {
  const r = resolveOutletFromUrl('https://www.wsj.com/articles/hamilton-review-1438821601');
  assert.equal(r?.outletId, 'wsj');
});

test('real online.wsj.com SB article URL resolves to wsj', () => {
  const r = resolveOutletFromUrl('http://online.wsj.com/article/SB10001424052748703989304575504040839405642.html');
  assert.equal(r?.outletId, 'wsj');
});

test('AP id appearing only in the query string does not null a real WSJ URL', () => {
  const r = resolveOutletFromUrl(`https://www.wsj.com/articles/some-review-123?ref=/article/${AP_ID}`);
  assert.equal(r?.outletId, 'wsj');
});

test('short "AP" path segment (not a 32-hex wire id) still resolves to wsj', () => {
  const r = resolveOutletFromUrl('https://www.wsj.com/article/APPLAUSE-review.html');
  assert.equal(r?.outletId, 'wsj');
});

test('syndication portal precedent (BRO-4502) unchanged', () => {
  assert.equal(resolveOutletFromUrl('https://news.yahoo.com/review-broadway-show-123.html'), null);
});

test('unrelated outlets unaffected', () => {
  assert.equal(resolveOutletFromUrl('https://www.nytimes.com/2024/01/01/theater/review.html')?.outletId, 'nytimes');
  assert.equal(resolveOutletFromUrl(null), null);
});

import { createRequire as __cr } from 'node:module';
test('resolveCanonicalOutletId keeps operator outlet for AP wire URL on wsj.com (BRO-5289)', () => {
  const { resolveCanonicalOutletId } = __cr(import.meta.url)('./outlet-canonicalize.js');
  const ap = 'https://www.wsj.com/article/AP0f81b3d24e44422db6feb5b187e37a66.html';
  assert.equal(resolveCanonicalOutletId({ outletArg: 'ap', url: ap }).outletId, 'ap');
  assert.equal(resolveCanonicalOutletId({ outletArg: 'wsj', url: 'https://www.wsj.com/articles/foo-11111' }).outletId, 'wsj');
});

test('validateUrlDomain accepts an AP wire page for outlet ap but not for another outlet or a plain wsj url', () => {
  const { validateUrlDomain } = require('./url-discovery.js');
  assert.equal(validateUrlDomain(`https://online.wsj.com/article/${AP_ID}.html`, 'ap').valid, true);
  assert.equal(validateUrlDomain('https://www.wsj.com/articles/hamilton-review-1438821601', 'ap').valid, false);
  assert.equal(validateUrlDomain(`https://online.wsj.com/article/${AP_ID}.html`, 'nytimes').valid, false);
});
