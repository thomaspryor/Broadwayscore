/**
 * Acceptance test for BRO-3322 (Safe House / off-broadway-2026: 4 critics
 * double-counted via BWW-roundup excerpt mis-attributed to their own byline
 * as outletId).
 *
 * Root cause and fix already shipped under BRO-3247 (fca8c83e927,
 * scripts/gather-reviews.js `extractBWWRoundupReviews`): when a BWW
 * roundup's JSON-LD `author.name` is a bare critic name with none of the
 * three delimiters the parser knows ("Outlet - Critic", "Critic, Outlet",
 * "Outlet: Critic"), the code used to fall through to `outletRaw =
 * authorName`, minting the critic's own name as a phantom outletId
 * (criticName left null) instead of resolving their real outlet — and
 * without dedup, that phantom slot survived alongside the correctly
 * attributed record for the same critic, double-counting their review in
 * the show's composite score.
 *
 * This file is the exact command BRO-3322's acceptance criteria names
 * (`node --test scripts/lib/bww-roundup-ingestion.test.mjs`). The full
 * edge-case suite (registered-outlet guard rails, delimiter shapes) lives at
 * tests/unit/bww-roundup-bare-author-name.test.mjs.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { extractBWWRoundupReviews } = require('../gather-reviews.js');

const BWW_URL = 'https://www.broadwayworld.com/article/Review-Roundup-SAFE-HOUSE-20260911';

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

describe('BRO-3322: BWW-roundup ingestion resolves real outlets and dedupes critics', () => {
  test('a bare critic name in author.name resolves to the real outlet, not the critic as outletId', () => {
    const html = makeLiveBlogHtml([
      {
        author: 'Jon Sobel',
        headline: 'Blogcritics - Theater Review (NYC): Safe House',
        text: 'A gripping state-of-the-nation drama.',
      },
    ]);

    const reviews = extractBWWRoundupReviews(html, 'safe-house-off-broadway-2026', BWW_URL);

    assert.strictEqual(reviews.length, 1);
    assert.strictEqual(reviews[0].outletId, 'blogcritics',
      `outletId must be the critic's real outlet, not the critic's own name, got "${reviews[0].outletId}"`);
    assert.notStrictEqual(reviews[0].outletId, 'jon-sobel');
  });

  test('a bare-name posting and its correctly-attributed twin collapse to one review, not two', () => {
    // The live corruption shape from Safe House: the same critic's review
    // reaches Method 1 twice — once as a bare author name, once already
    // delimited "Outlet - Critic". Without dedup this produced two slots for
    // one critic and double-counted them in the composite score.
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
      `same critic must not be double-counted, got ${JSON.stringify(reviews.map(r => [r.outletId, r.criticName]))}`);
    assert.strictEqual(reviews[0].outletId, 'blogcritics');
    assert.strictEqual(reviews[0].criticName, 'Jon Sobel');
  });

  test('four bare-name critics from the real Safe House shape each resolve to their own real outlet exactly once', () => {
    const html = makeLiveBlogHtml([
      { author: 'Jon Sobel', headline: 'Blogcritics - Theater Review (NYC): Safe House', text: 'Review 1.' },
      { author: 'Ross', headline: 'Front Mezz Junkies - Theater Review: Safe House', text: 'Review 2.' },
      { author: 'Mack Muldofsky', headline: 'StageBuddy - Theater Review: Safe House', text: 'Review 3.' },
      { author: 'Suzanna Bowling', headline: 'Times Square Chronicles - Theater Review: Safe House', text: 'Review 4.' },
    ]);

    const reviews = extractBWWRoundupReviews(html, 'safe-house-off-broadway-2026', BWW_URL);

    assert.strictEqual(reviews.length, 4);
    const pairs = reviews.map(r => [r.outletId, r.criticName]).sort();
    assert.deepStrictEqual(pairs,
      [
        ['blogcritics', 'Jon Sobel'],
        ['frontmezzjunkies', 'Ross'],
        ['stagebuddy', 'Mack Muldofsky'],
        ['times-square-chronicles', 'Suzanna Bowling'],
      ].sort(),
      `each critic must resolve to their own real outlet, got ${JSON.stringify(pairs)}`);
    const outletIds = reviews.map(r => r.outletId);
    for (const bogusId of ['jon-sobel', 'ross', 'mack-muldofsky', 'suzanna-bowling']) {
      assert.ok(!outletIds.includes(bogusId), `critic name must never become an outletId, found "${bogusId}"`);
    }
  });
});
