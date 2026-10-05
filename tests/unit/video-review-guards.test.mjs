// BRO-4328: video reviews were published under show ids missing from
// shows.json, and one video appeared on two shows. require()s the real guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { filterPublishableReviews } = require('../../scripts/lib/video-review-guards.js');

const r = (videoUrl) => ({ videoUrl, score: 70 });

test('unknown show ids are dropped', () => {
  const { kept, dropped } = filterPublishableReviews(
    { 'beaches-2025': [r('a')], 'beaches-2026': [r('b')] },
    new Set(['beaches-2026']),
  );
  assert.deepEqual(Object.keys(kept), ['beaches-2026']);
  assert.deepEqual(dropped.map(d => [d.showId, d.reason]), [['beaches-2025', 'unknown show id']]);
});

test('a video on an unknown id and a known id survives on the known one', () => {
  const { kept } = filterPublishableReviews(
    { 'beaches-2025': [r('dup')], 'beaches-2026': [r('dup')] },
    new Set(['beaches-2026']),
  );
  assert.deepEqual(kept, { 'beaches-2026': [r('dup')] });
});

test('a video on two known shows is dropped from both', () => {
  const { kept, dropped } = filterPublishableReviews(
    { 'hamlet-off-broadway-2026': [r('x'), r('y')], 'hamlet-2023': [r('x')] },
    new Set(['hamlet-off-broadway-2026', 'hamlet-2023']),
  );
  assert.deepEqual(kept, { 'hamlet-off-broadway-2026': [r('y')] });
  assert.equal(dropped.length, 2);
});

test('url-less reviews are kept on known shows and never treated as duplicates', () => {
  const { kept, dropped } = filterPublishableReviews(
    { a: [{ score: 1 }], b: [{ score: 2 }], gone: [{ score: 3 }] },
    new Set(['a', 'b']),
  );
  assert.deepEqual(kept, { a: [{ score: 1 }], b: [{ score: 2 }] });
  assert.deepEqual(dropped.map(d => d.showId), ['gone']);
});

test('isPaidPromotion matches creator ad labels, not press tickets (BRO-4760)', () => {
  const { isPaidPromotion } = require('../../scripts/lib/video-review-guards.js');
  assert.equal(isPaidPromotion({ title: '#ad Had a shining, shimmering spectacular date night at Alad...' }), true);
  assert.equal(isPaidPromotion({ title: 'Wicked review #sponsored' }), true);
  assert.equal(isPaidPromotion({ transcript: 'This video is sponsored by Audible.' }), true);
  assert.equal(isPaidPromotion({ transcript: 'in a paid partnership with the show' }), true);
  assert.equal(isPaidPromotion({ transcript: 'I was fortunate to get press tickets for this. Thank you so much, Irish Rep.' }), false);
  assert.equal(isPaidPromotion({ transcript: 'Red Bull has partnered with the Public Theater to present the run' }), false);
  assert.equal(isPaidPromotion({ title: 'the #adaptation was great', transcript: 'a broad ad campaign' }), false);
  assert.equal(isPaidPromotion({}), false);
});
