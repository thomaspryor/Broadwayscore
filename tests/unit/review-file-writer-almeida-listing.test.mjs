import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { createOrMergeReviewFile } = require('../../scripts/lib/review-file-writer.js');
const { listingPageUrlReason } = require('../../scripts/lib/non-review-url-patterns.js');
const reviewTextsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'almeida-listing-test-'));
const showId = 'triumph-off-west-end-2026';
// An existing folder keeps the test independent of private shows.json data.
fs.mkdirSync(path.join(reviewTextsDir, showId));
after(() => fs.rmSync(reviewTextsDir, { recursive: true, force: true }));

for (const url of [
  'https://almeida.co.uk/whats-on/',
  'https://almeida.co.uk/whats-on',
  'https://www.almeida.co.uk/whats-on/?ref=roundup',
]) {
  test(`refuses an aggregator's venue-listing citation: ${url}`, () => {
    assert.equal(listingPageUrlReason(url), 'venue-listing-page');
    const result = createOrMergeReviewFile(showId, {
      outletId: 'almeidacouk', outlet: 'Almeida Theatre', criticName: 'Unknown',
      url, source: 'theatre-reviews', fields: { theatreReviewsStars: '3/5' },
    }, { reviewTextsDir });
    assert.equal(result.action, 'skipped');
    assert.equal(result.reason, 'listing-page-url: venue-listing-page');
    assert.equal(result.guardRefused, true);
    assert.deepEqual(fs.readdirSync(path.join(reviewTextsDir, showId)), []);
  });
}

test('preserves article URLs and other hosts', () => {
  for (const url of [
    'https://www.theguardian.com/stage/2026/oct/21/triumph-review',
    'https://musicaltheatrereview.com/music-review-the-great-gatsby-a-new-musical/',
    'https://www.broadwayworld.com/bwwopera/article/Review-LINCOLN-20261020',
    'https://www.express.co.uk/entertainment/theatre/1845793/stranger-things-theatrical-prequel-stephen-daldry',
    'https://example.com/whats-on/',
    'https://notalmeida.co.uk/whats-on/',
    'https://almeida.co.uk.example.com/whats-on/',
  ]) {
    assert.equal(listingPageUrlReason(url), null, url);
  }
});
