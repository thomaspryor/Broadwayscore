// BRO-6606: the shared urlLooksLikeReview refuses film-fan, book shop and announcement URLs for every caller.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { urlLooksLikeReview } = require('./review-guards.js');

test('urlLooksLikeReview refuses non-review hosts and announcement slugs', () => {
  for (const u of [
    'https://letterboxd.com/pattinsins/film/the-little-mermaid-2023/',
    'https://timesbookshop.co.uk/pig-heart-boy-9781839044472/',
    'https://theatreweekly.com/full-details-announced-for-jekyll-hyde-at-liverpool-everyman-this-july/',
  ]) assert.equal(urlLooksLikeReview(u, 'Jekyll and Hyde'), false, u);
});

test('urlLooksLikeReview still accepts a real review URL', () => {
  assert.equal(
    urlLooksLikeReview('https://www.theguardian.com/stage/article/2024/jun/27/sense-and-sensibility-review-pitlochry-festival-theatre', 'Sense and Sensibility'),
    true,
  );
});

test('an announcement-token slug that is a review still passes', () => {
  assert.equal(urlLooksLikeReview('https://example.com/reviews/jekyll-hyde-uk-tour-review', 'Jekyll and Hyde'), true);
});

// BRO-7077 (BRO-5866 cousin): a one-repeated-word title ("Fire Fire") passed the
// per-word slug check on a single "fire" (Wirecutter fire-pit buying guide).
test('one-repeated-word titles need the word twice or a stage cue (BRO-7077)', () => {
  const { urlLooksLikeReview: u, repeatedTitleWordsPresent: rep } = require('./review-guards');
  assert.equal(u('https://www.nytimes.com/wirecutter/reviews/best-smokeless-fire-pits/', 'Fire Fire'), false);
  assert.equal(u('https://www.nytimes.com/2026/10/01/theater/fire-fire-review.html', 'Fire Fire'), true);
  assert.equal(u('https://www.theguardian.com/stage/2026/love-love-love-review', 'Love, Love, Love'), true);
  assert.equal(u('https://www.standard.co.uk/culture/theatre/lemons-harold-pinter-theatre-review-jenna-coleman-b1056865.html', 'Lemons Lemons Lemons Lemons Lemons'), true, 'one word + theatre cue');
  assert.equal(u('https://example.com/boeing-boeing-review-broadway', 'Boeing-Boeing'), true);
  assert.equal(rep('https://example.com/are-you-now-review', ['are', 'you', 'now', 'have', 'you', 'ever', 'been']), true, 'filler repeats never gate');
  assert.equal(rep('https://example.com/promises-kept', ['promises', 'promises']), false);
});
