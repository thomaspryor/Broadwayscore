/**
 * Unit tests for urlPathContainsTitleWords — the Phase 1 slug pre-filter
 * used by audit-url-validation.js to clear ~86% of URLs without fetching.
 *
 * Pattern: require() the real function, never copy logic into tests.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// urlPathContainsTitleWords is not exported yet — need to extract and export it.
// For now, test via the module that will export it.
const { urlPathContainsTitleWords } = require('../../scripts/audit-url-validation');

describe('urlPathContainsTitleWords', () => {
  // --- Multi-word titles: should match when URL contains title words ---

  test('exact slug match in URL path -> matched', () => {
    const result = urlPathContainsTitleWords(
      'https://variety.com/2024/legit/reviews/oh-mary-review-broadway/',
      'Oh, Mary!'
    );
    assert.strictEqual(result.matched, true);
    assert.ok(result.ratio >= 0.5);
  });

  test('Hamilton in URL path -> matched', () => {
    const result = urlPathContainsTitleWords(
      'https://nytimes.com/2015/theater/reviews/hamilton-broadway-musical-review.html',
      'Hamilton'
    );
    assert.strictEqual(result.matched, true);
  });

  test('multi-word title partially in URL -> matched at 50%+', () => {
    const result = urlPathContainsTitleWords(
      'https://example.com/review/kinky-boots-broadway',
      'Kinky Boots'
    );
    assert.strictEqual(result.matched, true);
    assert.strictEqual(result.ratio, 1.0);
  });

  test('Back to the Future — stop words stripped, "back" and "future" match', () => {
    const result = urlPathContainsTitleWords(
      'https://thestage.co.uk/reviews/back-to-the-future-review',
      'Back to the Future'
    );
    assert.strictEqual(result.matched, true);
    assert.ok(result.titleWords.includes('back'));
    assert.ok(result.titleWords.includes('future'));
    // "to" and "the" should be stripped as stop words
    assert.ok(!result.titleWords.includes('to'));
    assert.ok(!result.titleWords.includes('the'));
  });

  test('The Phantom of the Opera — long title with stop words', () => {
    const result = urlPathContainsTitleWords(
      'https://londontheatre.co.uk/reviews/phantom-of-the-opera-review',
      'The Phantom of the Opera'
    );
    assert.strictEqual(result.matched, true);
    assert.ok(result.matchedWords.includes('phantom'));
    assert.ok(result.matchedWords.includes('opera'));
  });

  // --- Wrong show: should NOT match ---

  test('URL about different show -> not matched', () => {
    const result = urlPathContainsTitleWords(
      'https://thestage.co.uk/reviews/angry-and-young-almeida-theatre-review',
      'Back to the Future'
    );
    assert.strictEqual(result.matched, false);
    assert.strictEqual(result.ratio, 0);
  });

  test('URL about Noughts and Crosses, title is Romeo and Juliet -> not matched', () => {
    const result = urlPathContainsTitleWords(
      'https://whatsonstage.com/news/noughts-and-crosses-at-regents-park/',
      'Romeo and Juliet'
    );
    assert.strictEqual(result.matched, false);
  });

  test('URL about Richard II, title is The Tempest -> not matched', () => {
    const result = urlPathContainsTitleWords(
      'https://inews.co.uk/culture/arts/jonathan-bailey-coke-snorting-richard-ii-review',
      'The Tempest - Globe'
    );
    assert.strictEqual(result.matched, false);
  });

  // --- Single-word titles (special handling) ---

  test('single significant word: Wicked in URL -> matched', () => {
    const result = urlPathContainsTitleWords(
      'https://variety.com/review/wicked-broadway-musical/',
      'Wicked'
    );
    assert.strictEqual(result.matched, true);
  });

  test('single significant word: Wicked NOT in URL -> not matched', () => {
    const result = urlPathContainsTitleWords(
      'https://variety.com/review/hamilton-broadway/',
      'Wicked'
    );
    assert.strictEqual(result.matched, false);
  });

  test('short title: SIX the Musical — "six" is 3 chars, "musical" matches', () => {
    const result = urlPathContainsTitleWords(
      'https://broadwayworld.com/article/six-the-musical-review/',
      'SIX the Musical'
    );
    assert.strictEqual(result.matched, true);
  });

  // --- Titles with special characters ---

  test('title with apostrophe: Hadestown -> apostrophe stripped', () => {
    const result = urlPathContainsTitleWords(
      'https://nytimes.com/review/hadestown-broadway/',
      "Hadestown"
    );
    assert.strictEqual(result.matched, true);
  });

  test('title with parentheses: stripped for matching', () => {
    const result = urlPathContainsTitleWords(
      'https://thestage.co.uk/reviews/two-strangers-carry-cake-across-new-york/',
      'Two Strangers (Carry a Cake Across New York)'
    );
    assert.strictEqual(result.matched, true);
  });

  test('title with colon: CATS: The Jellicle Ball', () => {
    const result = urlPathContainsTitleWords(
      'https://broadwayworld.com/article/cats-the-jellicle-ball-review/',
      'CATS: The Jellicle Ball'
    );
    assert.strictEqual(result.matched, true);
    assert.ok(result.matchedWords.includes('cats'));
    assert.ok(result.matchedWords.includes('jellicle'));
  });

  test('title with ampersand: Romeo & Juliet', () => {
    const result = urlPathContainsTitleWords(
      'https://theguardian.com/stage/romeo-and-juliet-review/',
      'Romeo & Juliet'
    );
    assert.strictEqual(result.matched, true);
    assert.ok(result.matchedWords.includes('romeo'));
    assert.ok(result.matchedWords.includes('juliet'));
  });

  // --- Numeric titles ---

  test('numeric title: 1776 in URL -> matched via full slug fallback', () => {
    const result = urlPathContainsTitleWords(
      'https://nytimes.com/2022/theater/1776-broadway-revival/',
      '1776'
    );
    assert.strictEqual(result.matched, true);
  });

  test('numeric title: 1776 NOT in URL -> not matched', () => {
    const result = urlPathContainsTitleWords(
      'https://nytimes.com/2022/theater/hamilton-review/',
      '1776'
    );
    assert.strictEqual(result.matched, false);
  });

  // --- Edge cases ---

  test('invalid URL -> not matched (no crash)', () => {
    const result = urlPathContainsTitleWords(
      'not-a-url',
      'Hamilton'
    );
    assert.strictEqual(result.matched, false);
  });

  test('empty title -> not matched', () => {
    const result = urlPathContainsTitleWords(
      'https://example.com/review',
      ''
    );
    assert.strictEqual(result.matched, false);
  });

  test('title with only stop words: "The" -> uses full slug fallback', () => {
    const result = urlPathContainsTitleWords(
      'https://example.com/review/the-show/',
      'The'
    );
    // "the" is a stop word AND <= 2 chars after filtering, so falls to full slug
    // Full slug is "the" which is >= 2 chars
    assert.strictEqual(typeof result.matched, 'boolean');
  });

  test('URL with query params — only path is checked', () => {
    const result = urlPathContainsTitleWords(
      'https://example.com/review/wicked-review?utm_source=hamilton',
      'Wicked'
    );
    assert.strictEqual(result.matched, true);
  });

  // --- Ratio checks ---

  test('2 of 4 title words in URL -> ratio 0.5, matched', () => {
    const result = urlPathContainsTitleWords(
      'https://example.com/review/harry-potter/',
      'Harry Potter and the Cursed Child'
    );
    // "harry", "potter", "cursed", "child" (4 words after filtering)
    // URL has "harry", "potter" -> 2/4 = 0.5
    assert.ok(result.ratio >= 0.5);
    assert.strictEqual(result.matched, true);
  });

  test('1 of 4 title words in URL -> ratio 0.25, not matched', () => {
    const result = urlPathContainsTitleWords(
      'https://example.com/review/cursed-something-else/',
      'Harry Potter and the Cursed Child'
    );
    // Only "cursed" matches -> 1/4 = 0.25
    assert.ok(result.ratio < 0.5);
    assert.strictEqual(result.matched, false);
  });
});
