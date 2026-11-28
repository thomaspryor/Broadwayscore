// BRO-6496: outlet-first candidate matching and notability. Requires the real functions (CLAUDE.md §15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { titleKey, cleanTitle, itemNames, notability, countsAsReview } = require('./ob-census-candidates.js');

test('notability: 2 T1/T2 outlets, or 1 T1 plus 2 others', () => {
  assert.equal(notability([2, 2]).notable, true);
  assert.equal(notability([1, 3, 3]).notable, true);
  assert.equal(notability([1, 3]).notable, false);
  assert.equal(notability([2, 3, 3]).notable, false);
  assert.deepEqual(notability([1, 2, 3]), { t1: 1, t12: 2, notable: true });
});

test('itemNames: multi-word titles match headline or URL slug as whole words', () => {
  const key = titleKey('Mother of the Maid');
  assert.equal(itemNames({ headline: "Glenn Close in 'Mother of the Maid'", url: 'https://x.com/a' }, key), true);
  assert.equal(itemNames({ headline: 'Review', url: 'https://www.theatermania.com/news/mother-of-the-maid-review_123/' }, key), true);
  assert.equal(itemNames({ headline: 'The Grandmother of the Maidens', url: 'https://x.com/b' }, key), false);
});

test('itemNames: a short one-word title needs the headline to be the title', () => {
  const key = titleKey('Love');
  assert.equal(itemNames({ headline: 'Love', url: 'https://x.com/love' }, key), true);
  assert.equal(itemNames({ headline: 'Love Review: a tender play', url: 'https://x.com/l' }, key), true);
  assert.equal(itemNames({ headline: 'Love and Information', url: 'https://x.com/love-and-information' }, key), false);
});

test('cleanTitle drops wrapping quotes and a market tag; titleKey folds & and accents', () => {
  assert.equal(cleanTitle('“the way she spoke”'), 'the way she spoke');
  assert.equal(cleanTitle('Coal Country (Off-Broadway)'), 'Coal Country');
  assert.equal(titleKey('Bob & Carol & Ted & Alice'), 'bob and carol and ted and alice');
  assert.equal(titleKey('Café Society'), 'cafe society');
});

test('itemNames: one word or article + word must sit next to "review" (BRO-6496 review)', () => {
  const light = titleKey('The Light');
  assert.equal(itemNames({ headline: 'The Light in the Piazza', url: 'https://x.com/the-light-in-the-piazza-review' }, light), false);
  assert.equal(itemNames({ headline: 'Review: The Light', url: 'https://x.com/r' }, light), true);
  const truth = titleKey('The True');
  assert.equal(itemNames({ headline: 'Exhibition', url: 'https://www.theatermania.com/news/black-exhibition-depicts-the-true-price_1/' }, truth), false);
  const hero = titleKey('Superhero');
  assert.equal(itemNames({ headline: 'Superhero musical gets a cast', url: 'https://x.com/s' }, hero), false);
  assert.equal(itemNames({ headline: 'x', url: 'https://x.com/superhero-review/' }, hero), true);
  assert.equal(itemNames({ headline: 'Frankenstein and Dracula double bill', url: 'https://x.com/d' }, titleKey('Frankenstein')), false);
});

test('countsAsReview: news and held URLs do not count; theater-scene not-review and out-of-window do', () => {
  assert.equal(countsAsReview('deadline', 'not-review'), false);
  assert.equal(countsAsReview('nytg', 'held'), false);
  assert.equal(countsAsReview('nytg', 'misfile'), false);
  assert.equal(countsAsReview('theater-scene', 'not-review'), true);
  assert.equal(countsAsReview('nytg', 'out-of-window'), true);
  assert.equal(countsAsReview('nytg', 'catalog-gap'), true);
});
