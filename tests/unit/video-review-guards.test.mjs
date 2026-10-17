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

test('creatorLookup resolves every creator handle in the live data (BRO-4760)', () => {
  const fs = require('fs'), path = require('path');
  const { creatorLookup } = require('../../scripts/lib/video-review-guards.js');
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), '../..');
  const creators = JSON.parse(fs.readFileSync(path.join(root, 'data/video-creators.json'), 'utf8')).creators;
  const find = creatorLookup(creators);
  assert.equal(find('MatthewHardyMusical').id, 'matthewhardymusical');
  assert.equal(find('TheatreReviewsWithPaulSeven').id, 'paulsevenlewis');
  assert.equal(find('nobody'), undefined);
  // first match wins in creatorLookup, so two creators sharing a key would silently swap
  const keys = creators.flatMap(c => [...new Set([c.id, c.platforms?.youtube?.channelHandle, c.platforms?.tiktok?.handle].filter(Boolean).map(k => k.toLowerCase()))]);
  assert.equal(new Set(keys).size, keys.length, 'two creators share an id/handle');
  const reviews = JSON.parse(fs.readFileSync(path.join(root, 'data/video-reviews.json'), 'utf8'));
  for (const [showId, list] of Object.entries(reviews)) {
    if (showId === '_meta') continue;
    for (const r of list) {
      const c = find(r.handle);
      assert.ok(c, `${showId}: no creator for handle ${r.handle}`);
      if (r.creatorId) assert.equal(r.creatorId, c.id, `${showId}: creatorId ${r.creatorId} vs ${c.id}`);
    }
  }
});

test('built video-reviews.json carries no "NA" dates (BRO-4760)', () => {
  const fs = require('fs'), path = require('path');
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), '../..');
  const reviews = JSON.parse(fs.readFileSync(path.join(root, 'data/video-reviews.json'), 'utf8'));
  const bad = Object.entries(reviews).filter(([k]) => k !== '_meta').flatMap(([k, l]) => l.filter(r => r.publishedAt === 'NA').map(() => k));
  assert.deepEqual(bad, []);
});
