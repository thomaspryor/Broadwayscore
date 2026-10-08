import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isBlockedReviewUrl } = require('../../scripts/lib/domain-filters.js');

// BRO-4886: a BWW roundup linked a NYT topic page; the parser registered "Ricky Martin" as an outlet
// and Evita 2012 counted a 45 for it.
test('topic and people index pages are not review URLs', () => {
  assert.equal(isBlockedReviewUrl('https://topics.nytimes.com/top/reference/timestopics/people/m/ricky-martin/index.html?inline=nyt-per'), true);
  assert.equal(isBlockedReviewUrl('https://topics.example.com/anything'), true);
  assert.equal(isBlockedReviewUrl('https://www.nytimes.com/top/reference/timestopics/people/m/ricky-martin/index.html'), true);
});

test('real review URLs on the same hosts still pass', () => {
  assert.equal(isBlockedReviewUrl('https://www.nytimes.com/2022/07/10/theater/into-the-woods-review.html'), false);
  assert.equal(isBlockedReviewUrl('https://theater.nytimes.com/2013/01/18/theater/reviews/cat-on-a-hot-tin-roof-at-richard-rodgers-theater.html'), false);
});
