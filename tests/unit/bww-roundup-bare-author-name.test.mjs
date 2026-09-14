/**
 * Regression test: BWW Roundup Method 1 must not mint a phantom outlet from a
 * bare critic name.
 *
 * Bug (Safe House / BRO-3247, 2026-09-14): BWW's JSON-LD sometimes carries
 * `author.name` as a bare critic name with none of the three delimiters the
 * parser knows ("Outlet - Critic", "Critic, Outlet", "Outlet: Critic") — e.g.
 * `author.name = "Jon Sobel"`. Every branch fell through to the catch-all
 * `outletRaw = authorName`, so the critic's own name became the OUTLET
 * ("jon-sobel") with `criticName = null`. That auto-registered a phantom
 * outlet and produced a permanent duplicate sitting beside the real,
 * correctly-attributed record ("blogcritics" / "Jon Sobel") for the same
 * review — double-counted in the composite score. Four such pairs shipped
 * live on safe-house-off-broadway-2026.
 *
 * Fix: when the bare author name is NOT a registered outlet, fall back to the
 * posting's own `headline` ("Outlet - Title") for the outlet and demote the
 * bare author name to criticName.
 *
 * Guard rails the fix must keep:
 *   - a bare author name that IS a registered outlet stays the outlet
 *     (outlet-only postings are legitimate — see bww-roundup-multi-critic).
 *   - the headline outlet is only trusted when it too is registered, so a
 *     headline fragment can't overwrite a real author attribution.
 *
 * Synthetic HTML only — no network.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { extractBWWRoundupReviews } = require('../../scripts/gather-reviews.js');

function makeLiveBlogHtml(postings) {
  const ld = {
    '@type': 'LiveBlogPosting',
    articleBody: postings.map(p => p.text || '').join('\n\n'),
    liveBlogUpdate: postings.map(p => {
      const entry = {
        '@type': 'BlogPosting',
        headline: p.headline,
        articleBody: p.text || p.headline,
      };
      if (p.author) entry.author = { '@type': 'Person', name: p.author };
      return entry;
    }),
  };
  return `<html><body><script type="application/ld+json">${JSON.stringify(ld)}</script></body></html>`;
}

const BWW_URL = 'https://www.broadwayworld.com/article/Review-Roundup-SAFE-HOUSE-20260911';

describe('BWW Roundup Method 1: bare critic name in author.name', () => {
  test('bare author name + registered outlet in headline → outlet from headline, name demoted to critic', () => {
    const html = makeLiveBlogHtml([
      {
        author: 'Jon Sobel',
        headline: 'Blogcritics - Theater Review (NYC): Safe House',
        text: 'A gripping state-of-the-nation drama.',
      },
    ]);

    const reviews = extractBWWRoundupReviews(html, 'safe-house-off-broadway-2026', BWW_URL);

    assert.strictEqual(reviews.length, 1, 'expected exactly one review slot');
    const r = reviews[0];
    assert.strictEqual(r.outletId, 'blogcritics',
      `outlet must come from the headline, got "${r.outletId}"`);
    assert.strictEqual(r.criticName, 'Jon Sobel',
      `bare author name must be demoted to criticName, got ${JSON.stringify(r.criticName)}`);
  });

  test('no phantom outlet is minted from the critic name', () => {
    const html = makeLiveBlogHtml([
      {
        author: 'Jon Sobel',
        headline: 'Blogcritics - Theater Review (NYC): Safe House',
        text: 'A gripping state-of-the-nation drama.',
      },
    ]);

    const reviews = extractBWWRoundupReviews(html, 'safe-house-off-broadway-2026', BWW_URL);
    const phantom = reviews.filter(r => r.outletId === 'jon-sobel');
    assert.strictEqual(phantom.length, 0,
      'critic name must never become an outletId (phantom-outlet regression)');
  });

  test('the real record and the phantom no longer coexist as a duplicate pair', () => {
    // The live corruption shape: the same critic reached Method 1 twice, once
    // via a bare-author posting and once via a properly delimited one. Before
    // the fix that produced two slots ("jon-sobel"/null and
    // "blogcritics"/"Jon Sobel"); after it, both normalize to the same
    // outlet+critic and the Method 1 dedup collapses them to one.
    const html = makeLiveBlogHtml([
      {
        author: 'Jon Sobel',
        headline: 'Blogcritics - Theater Review (NYC): Safe House',
        text: 'A gripping state-of-the-nation drama.',
      },
      {
        author: 'Blogcritics - Jon Sobel',
        headline: 'Blogcritics - Theater Review (NYC): Safe House',
        text: 'A gripping state-of-the-nation drama.',
      },
    ]);

    const reviews = extractBWWRoundupReviews(html, 'safe-house-off-broadway-2026', BWW_URL);
    assert.strictEqual(reviews.length, 1,
      `duplicate pair must collapse to one slot, got ${JSON.stringify(reviews.map(r => [r.outletId, r.criticName]))}`);
    assert.strictEqual(reviews[0].outletId, 'blogcritics');
    assert.strictEqual(reviews[0].criticName, 'Jon Sobel');
  });

  test('bare author name that IS a registered outlet stays the outlet', () => {
    // Guard rail: outlet-only author attribution must be untouched by the fix,
    // otherwise every outlet-authored posting loses its outlet.
    const html = makeLiveBlogHtml([
      {
        author: 'Blogcritics',
        headline: 'Blogcritics - Theater Review (NYC): Safe House',
        text: 'A gripping state-of-the-nation drama.',
      },
    ]);

    const reviews = extractBWWRoundupReviews(html, 'safe-house-off-broadway-2026', BWW_URL);
    assert.strictEqual(reviews.length, 1);
    assert.strictEqual(reviews[0].outletId, 'blogcritics');
    assert.strictEqual(reviews[0].criticName, null,
      'a registered-outlet author name must not be demoted to criticName');
  });

  test('unregistered headline outlet does not overwrite the author attribution', () => {
    // Guard rail: the headline fallback only fires when the headline's leading
    // segment is itself a registered outlet. A headline fragment must not be
    // promoted over the author name.
    const html = makeLiveBlogHtml([
      {
        author: 'Jon Sobel',
        headline: 'Some Unregistered Zine - Safe House at Theatre Row',
        text: 'A gripping state-of-the-nation drama.',
      },
    ]);

    const reviews = extractBWWRoundupReviews(html, 'safe-house-off-broadway-2026', BWW_URL);
    assert.strictEqual(reviews.length, 1);
    assert.strictEqual(reviews[0].outletId, 'jon-sobel',
      'without a registered headline outlet the pre-fix behavior is preserved');
    assert.strictEqual(reviews[0].criticName, null);
  });
});
