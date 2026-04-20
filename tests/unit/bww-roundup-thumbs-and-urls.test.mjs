/**
 * Regression tests for three BWW Roundup extractor bugs surfaced by the
 * Fallen Angels 2026-04-19 opening night:
 *
 *   1. Thumb pattern missed legacy BigThumbs_(UP|MEH|DOWN).gif and matched
 *      only the new *trans.png format → every review on pages using the
 *      legacy assets shipped with bwwThumb=null.
 *   2. Multi-critic URL assignment used a first-URL-wins map keyed by
 *      outletId. Three NYSR reviews for FA all inherited the first NYSR
 *      source URL found in the roundup HTML, overriding the correct URLs.
 *   3. Count drift between anchor-tag review URLs in the HTML and the
 *      reviews array (e.g. BWW edited in new reviews after our initial
 *      extraction) went unannounced — silently missing critics.
 *
 * These tests exercise synthetic HTML only; they are part of the no-data-
 * dependency unit job.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { extractBWWRoundupReviews } = require('../../scripts/gather-reviews.js');

function liveBlogHtml({ postings, articleBody = '', extraImages = '', extraAnchors = '' }) {
  const ld = {
    '@type': 'LiveBlogPosting',
    articleBody: articleBody || postings.map(p => p.text || p.headline).join('\n\n'),
    liveBlogUpdate: postings.map(p => ({
      '@type': 'BlogPosting',
      headline: p.headline,
      author: p.author ? { name: p.author } : undefined,
      articleBody: p.text || p.headline,
    })),
  };
  return `<html><body>${extraImages}${extraAnchors}<script type="application/ld+json">${JSON.stringify(ld)}</script></body></html>`;
}

describe('BWW Roundup: thumb extraction', () => {
  test('matches legacy BigThumbs_(UP|MEH|DOWN).gif format', () => {
    const postings = [
      { headline: 'New York Times - Show Review', author: 'The New York Times - Jesse Green' },
      { headline: 'Variety - Show Review', author: 'Variety - Naveen Kumar' },
      { headline: 'New York Post - Show Review', author: 'New York Post - Johnny Oleksinski' },
    ];
    const extraImages =
      '<img src="/images/BigThumbs_UP.gif">' +
      '<img src="/images/BigThumbs_MEH.gif">' +
      '<img src="/images/BigThumbs_DOWN.gif">';
    const html = liveBlogHtml({ postings, extraImages });

    const reviews = extractBWWRoundupReviews(
      html, 'show-2026', 'https://www.broadwayworld.com/article/test', 'Show'
    );

    const thumbs = reviews.map(r => r.bwwThumb);
    assert.deepStrictEqual(thumbs, ['Up', 'Meh', 'Down'],
      `expected legacy BigThumbs_* pattern to produce [Up, Meh, Down], got ${JSON.stringify(thumbs)}`);
  });

  test('matches new lowercase uptrans/middletrans/downtrans.png format', () => {
    const postings = [
      { headline: 'Variety - Show Review', author: 'Variety - Naveen Kumar' },
      { headline: 'New York Post - Show Review', author: 'New York Post - Johnny Oleksinski' },
    ];
    const extraImages =
      '<img src="/cdn/uptrans.png">' +
      '<img src="/cdn/downtrans.png">';
    const html = liveBlogHtml({ postings, extraImages });

    const reviews = extractBWWRoundupReviews(
      html, 'show-2026', 'https://www.broadwayworld.com/article/test', 'Show'
    );
    assert.deepStrictEqual(reviews.map(r => r.bwwThumb), ['Up', 'Down']);
  });

  test('mixed legacy + new format pages still produce one thumb per review', () => {
    const postings = [
      { headline: 'Variety - Show Review', author: 'Variety - Naveen Kumar' },
      { headline: 'New York Post - Show Review', author: 'New York Post - Johnny Oleksinski' },
    ];
    const extraImages =
      '<img src="/images/BigThumbs_UP.gif">' +
      '<img src="/cdn/middletrans.png">';
    const html = liveBlogHtml({ postings, extraImages });

    const reviews = extractBWWRoundupReviews(
      html, 'show-2026', 'https://www.broadwayworld.com/article/test', 'Show'
    );
    assert.deepStrictEqual(reviews.map(r => r.bwwThumb), ['Up', 'Meh']);
  });
});

describe('BWW Roundup: multi-critic URL distribution', () => {
  test('three NYSR reviews get three DIFFERENT URLs from anchor queue', () => {
    const postings = [
      { headline: 'New York Stage Review - Show: Take 1' },
      { headline: 'New York Stage Review - Show: Take 2' },
      { headline: 'New York Stage Review - Show: Take 3' },
    ];
    const articleBody =
      "Let's see what the critics had to say..." +
      '\n\nDavid Finkle, New York Stage Review: <a href="https://newyorkstagereview.com/finkle-on-show/">Read more</a>' +
      '\n\nFrank Scheck, New York Stage Review: <a href="https://newyorkstagereview.com/scheck-on-show/">Read more</a>' +
      '\n\nRoma Torre, New York Stage Review: <a href="https://newyorkstagereview.com/torre-on-show/">Read more</a>';
    const extraAnchors =
      '<p>David Finkle, <a href="https://newyorkstagereview.com/finkle-on-show/">New York Stage Review:</a> praise.</p>' +
      '<p>Frank Scheck, <a href="https://newyorkstagereview.com/scheck-on-show/">New York Stage Review:</a> raves.</p>' +
      '<p>Roma Torre, <a href="https://newyorkstagereview.com/torre-on-show/">New York Stage Review:</a> dazzles.</p>';
    const html = liveBlogHtml({ postings, articleBody, extraAnchors });

    const reviews = extractBWWRoundupReviews(
      html, 'show-2026', 'https://www.broadwayworld.com/article/test', 'Show'
    );
    const nysrUrls = reviews
      .filter(r => r.outletId === 'nysr')
      .map(r => r.url)
      .filter(Boolean);

    assert.strictEqual(nysrUrls.length, 3,
      `expected 3 distinct NYSR URLs, got ${nysrUrls.length} (${JSON.stringify(nysrUrls)})`);
    const uniq = new Set(nysrUrls);
    assert.strictEqual(uniq.size, 3,
      `expected all 3 NYSR URLs to be distinct, got ${JSON.stringify(nysrUrls)}`);
  });

  test('single-critic outlets unaffected by queue change', () => {
    const postings = [
      { headline: 'Variety - Show Review', author: 'Variety - Naveen Kumar' },
    ];
    const articleBody =
      "Let's see what the critics had to say..." +
      '\n\nNaveen Kumar, Variety: <a href="https://variety.com/kumar/">Read</a>';
    const extraAnchors =
      '<p>Naveen Kumar, <a href="https://variety.com/kumar/">Variety:</a> praise.</p>';
    const html = liveBlogHtml({ postings, articleBody, extraAnchors });

    const reviews = extractBWWRoundupReviews(
      html, 'show-2026', 'https://www.broadwayworld.com/article/test', 'Show'
    );
    const variety = reviews.find(r => r.outletId === 'variety');
    assert.ok(variety, 'expected Variety review');
    assert.strictEqual(variety.url, 'https://variety.com/kumar/');
  });
});
