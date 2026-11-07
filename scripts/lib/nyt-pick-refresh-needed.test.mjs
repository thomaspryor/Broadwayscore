/**
 * Unit tests for scripts/lib/nyt-pick-refresh-needed.js.
 *
 * Run: node --test scripts/lib/nyt-pick-refresh-needed.test.mjs
 *
 * Regression: School Girls 2026 (2026-09-29) — Helen Shaw's NYT review was a
 * Critic's Pick but the badge waited for the Mon/Wed/Fri picks refresh.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { canonicalPickUrl, findUnpickedNytUrls, checkIsDue } = require('./nyt-pick-refresh-needed.js');

const NOW = new Date('2026-09-29T05:00:00Z');
const SHAW = 'https://www.nytimes.com/2026/09/28/theater/school-girls-or-the-african-mean-girls-play-review.html';
const nyt = (extra = {}) => ({ outletId: 'nytimes', url: SHAW, publishDate: '2026-09-29', ...extra });

test('recent NYT review not in the picks list needs a refresh', () => {
  const out = findUnpickedNytUrls({ shows: [{ showId: 's', reviews: [nyt()] }], pickUrls: [], now: NOW });
  assert.deepEqual(out, [SHAW]);
});

test('already-picked review (query string on either side) needs nothing', () => {
  const out = findUnpickedNytUrls({ shows: [{ showId: 's', reviews: [nyt({ url: SHAW + '?smid=url-share' })] }], pickUrls: [SHAW + '/'], now: NOW });
  assert.deepEqual(out, []);
});

test('old NYT review (e.g. a prior production kept in the folder) is ignored', () => {
  const out = findUnpickedNytUrls({ shows: [{ showId: 's', reviews: [nyt({ publishDate: '2001-10-19' })] }], pickUrls: [], now: NOW });
  assert.deepEqual(out, []);
});

test('flagged NYT reviews are ignored (top-level or contentVerification)', () => {
  const reviews = [
    nyt({ wrongProduction: true }),
    nyt({ contentVerification: { wrongShow: true } }),
    nyt({ isRoundupArticle: true }),
  ];
  assert.deepEqual(findUnpickedNytUrls({ shows: [{ showId: 's', reviews }], pickUrls: [], now: NOW }), []);
});

test('non-NYT reviews and missing dates are ignored', () => {
  const reviews = [
    { outletId: 'variety', url: 'https://variety.com/x', publishDate: '2026-09-29' },
    nyt({ publishDate: undefined }),
  ];
  assert.deepEqual(findUnpickedNytUrls({ shows: [{ showId: 's', reviews }], pickUrls: [], now: NOW }), []);
});

test('fresh opening-night stub without publishDate falls back to firstSeenAt', () => {
  const r = nyt({ publishDate: undefined, firstSeenAt: '2026-09-29T01:40:32.544Z' });
  assert.deepEqual(findUnpickedNytUrls({ shows: [{ showId: 's', reviews: [r] }], pickUrls: [], now: NOW }), [SHAW]);
});

test('canonicalPickUrl matches rebuild-all-reviews (origin + path, no trailing slash)', () => {
  assert.equal(canonicalPickUrl(SHAW + '/?ref=theater#x'), SHAW);
  assert.equal(canonicalPickUrl(''), '');
});

test('negative cache: due when never checked or older than the interval', () => {
  assert.equal(checkIsDue({ lastCheckedAt: null, now: NOW, minIntervalMin: 30 }), true);
  assert.equal(checkIsDue({ lastCheckedAt: '2026-09-29T04:40:00Z', now: NOW, minIntervalMin: 30 }), false);
  assert.equal(checkIsDue({ lastCheckedAt: '2026-09-29T04:20:00Z', now: NOW, minIntervalMin: 30 }), true);
});
