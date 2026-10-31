/**
 * BRO-3593: UK structural star extractors must not take a rating from a
 * "related reviews" sidebar. Calls the real extractUKStarRating.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractUKStarRating } = require('../../scripts/lib/score-extractors.js');

const stars = (filled) => (
  Array.from({ length: 5 }, (_, i) => (i < filled ? '<img src="/img/yellow.png">' : '<img src="/img/star-grey.png">')).join(''));

describe('WhatsOnStage star images', () => {
  test('article with no sidebar: own 5 images are read (unchanged behaviour)', () => {
    const html = `<div id="article-star-rating-container">${stars(4)}</div><div class="news-content">x</div>`;
    const r = extractUKStarRating(html, '');
    assert.equal(r.source, 'wos-star-images');
    assert.equal(r.originalScore, '4/5 stars');
  });

  test('sidebar with its own stars: only the article container counts', () => {
    const html = `<div id="article-star-rating-container">${stars(2)}</div><div class="news-content">review</div>` +
      `<aside class="related">${stars(5)}</aside>`;
    const r = extractUKStarRating(html, '');
    assert.equal(r.source, 'wos-star-images');
    assert.equal(r.originalScore, '2/5 stars');
  });

  test('no container and two rated blocks on the page: abstains (page count is not 5)', () => {
    const html = `<a href="https://www.whatsonstage.com/x">x</a>${stars(3)}${stars(5)}`;
    const r = extractUKStarRating(html, '');
    assert.ok(!r || r.source !== 'wos-star-images');
  });

  test('empty container falls back to the whole-page set of five', () => {
    const html = `<div id="article-star-rating-container"></div><div class="news-content">x</div>${stars(3)}`;
    const r = extractUKStarRating(html, '');
    assert.equal(r.originalScore, '3/5 stars');
  });
});

describe('Daily Mail rating_showbiz gif', () => {
  test('single value is read', () => {
    const r = extractUKStarRating('<img src="rating_showbiz_4.gif">', '');
    assert.equal(r.source, 'dailymail-rating-img');
    assert.equal(r.originalScore, '4/5 stars');
  });
  test('same value repeated is still that value', () => {
    const r = extractUKStarRating('<img src="rating_showbiz_4.gif"><img src="rating_showbiz_4.gif">', '');
    assert.equal(r.originalScore, '4/5 stars');
  });
  test('two different values (sidebar / roundup) abstain', () => {
    const r = extractUKStarRating('<img src="rating_showbiz_4.gif"><img src="rating_showbiz_2.gif">', '');
    assert.ok(!r || r.source !== 'dailymail-rating-img');
  });
});
