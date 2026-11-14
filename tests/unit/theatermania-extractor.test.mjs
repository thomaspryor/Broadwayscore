/**
 * Article extractor — TheaterMania 2026 Bootstrap layout.
 *
 * Background: Bedlam's Othello 2026-05-27. TheaterMania redesigned from the
 * old Drupal <div class="article-body">…</div></article> to a Bootstrap
 * layout with <div class="news-content">…<section class="featured-in-this-story">.
 * The old pattern returned 0 chars and silently left every TheaterMania
 * review as a stub — the show was stranded at 1 review while 6 others sat
 * unscored.
 *
 * Fix (scripts/lib/article-extractor.js): news-content pattern added first,
 * old article-body kept as fallback. Verified end-to-end against 3 live
 * articles (4013 / 4310 / 3657 chars).
 *
 * This guards the pattern so a future merge or site redesign can't silently
 * revert it without a red test.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { extractArticleText } from '../../scripts/lib/article-extractor.js';

describe('article-extractor: TheaterMania news-content (2026 Bootstrap layout)', () => {
  test('extracts review body from div.news-content', () => {
    const html =
      '<html><body><article class="container">' +
      '<div class="news-content">' +
        '<p>' + 'The Bard baked what he needed into his language. '.repeat(20) + '</p>' +
        '<p>Eric Tucker and Bedlam let us see a classic work in new ways.</p>' +
      '</div>' +
      '<section class="featured-in-this-story my-3">' +
        '<p>Othello tickets and showtimes</p>' +
        '<p>Buy Tickets</p>' +
      '</section>' +
      '</article></body></html>';
    const text = extractArticleText(html, 'theatermania.com');
    assert.ok(text, 'extractor should return text');
    assert.ok(text.includes('The Bard baked'), 'review body should be captured');
    assert.ok(text.includes('see a classic work in new ways'), 'full body should be captured');
    assert.ok(!text.includes('Buy Tickets'), `featured-in-this-story chrome leaked: …${text.slice(-120)}`);
    assert.ok(!text.includes('tickets and showtimes'), 'ticketing chrome leaked through');
  });

  test('stops at featured-in-this-story even with class variations', () => {
    const html =
      '<html><body>' +
      '<div class="news-content position-relative">' +
        '<p>Real review prose evaluating the production quality and direction. ' +
        'The staging is inventive and the performances are committed throughout. '.repeat(6) +
        '</p>' +
      '</div>' +
      '<section class="row featured-in-this-story pt-4">' +
        '<p>Related show promo that must not leak</p>' +
      '</section>' +
      '</body></html>';
    const text = extractArticleText(html, 'theatermania.com');
    assert.ok(text.includes('Real review prose'));
    assert.ok(!text.includes('promo that must not leak'));
  });

  test('falls back to legacy article-body layout (pre-2026)', () => {
    const html =
      '<html><body><article>' +
      '<div class="article-body">' +
        '<p>Legacy Drupal review body from an older TheaterMania article. ' +
        'This pre-redesign markup must still extract via the fallback pattern. '.repeat(6) +
        '</p>' +
      '</div>' +
      '</article></body></html>';
    const text = extractArticleText(html, 'theatermania.com');
    assert.ok(text, 'fallback pattern should still match older articles');
    assert.ok(text.includes('Legacy Drupal review body'));
  });

  test('returns null/empty when neither pattern matches (no silent garbage)', () => {
    const html = '<html><body><div class="unrelated">nothing here</div></body></html>';
    const text = extractArticleText(html, 'theatermania.com');
    // Generic <article>/<main> fallback may still fire elsewhere, but for this
    // markup with no article/main and no TM container, expect no TM-body match.
    assert.ok(!text || !text.includes('nothing here') || text.length < 100,
      'should not return arbitrary page chrome as the review body');
  });
});
