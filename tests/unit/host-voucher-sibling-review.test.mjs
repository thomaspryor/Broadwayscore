// BRO-7163 F10: a sibling review on the same host must not vouch for a different listed review.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { hostFallbackVouchers, urlsReadAsSameArticle } = require('../../scripts/lib/flagged-recovery.js');
const covered = (d) => d.included === true;
const long = 'x'.repeat(2000);

test('second Everything Theatre review of the same show is not vouched by the first', () => {
  const held = { url: 'https://everything-theatre.co.uk/2026/11/the-river-room-review-ann-smith/', included: true, fullText: long };
  const listed = 'https://everything-theatre.co.uk/2026/11/the-river-room-review-ben-jones-at-the-old-vic/';
  assert.deepEqual(hostFallbackVouchers([held], covered, listed), [], 'sibling review must stay visible as missing');
});

test('a real URL variant (same slug, extra tracking/segments) still vouches', () => {
  const held = { url: 'https://example.com/2026/11/the-river-room-review/', included: true, fullText: long };
  assert.equal(hostFallbackVouchers([held], covered, 'https://example.com/the-river-room-review?utm_source=x').length, 1);
});

test('opaque id URLs never vouch for each other', () => {
  assert.equal(urlsReadAsSameArticle('https://x.com/story.asp?ID=48291', 'https://x.com/story.asp?ID=48292'), false);
});

test('url-less and recoverable files keep vouching; legacy callers (no candidate) unchanged', () => {
  const f = { included: true, url: 'https://e.com/a-b-c', fullText: long };
  assert.equal(hostFallbackVouchers([f], covered).length, 1);
  assert.equal(hostFallbackVouchers([{ fullText: long }], covered, 'https://e.com/zzz').length, 1);
});
