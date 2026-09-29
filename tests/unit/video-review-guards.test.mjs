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
