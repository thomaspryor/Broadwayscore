/**
 * Unit tests for scripts/lib/show-score-discover.js
 *
 * Show Score reconciliation source for the gap audit — covers off-Broadway
 * (unlike DTLI). Added 2026-06-06 so a review that surfaces only on Show Score
 * (which lands later/fewer than Playbill/BWW) is still reconciled.
 *
 * Run: node --test tests/unit/show-score-discover.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  showScoreUrlForShow,
  extractShowScoreReviewUrls,
  extractReadMoreUrls,
  parseShowScorePagination,
  fetchAllShowScoreReviewUrls,
} = require('../../scripts/lib/show-score-discover.js');

describe('showScoreUrlForShow', () => {
  it('prefers the curated url map', () => {
    const show = { id: 'girl-interrupted-off-broadway-2026', title: 'Girl, Interrupted', category: 'off-broadway' };
    const map = { 'girl-interrupted-off-broadway-2026': 'https://www.show-score.com/off-broadway-shows/girl-interrupted' };
    assert.strictEqual(showScoreUrlForShow(show, map), 'https://www.show-score.com/off-broadway-shows/girl-interrupted');
  });

  it('constructs an off-broadway-shows URL when unmapped', () => {
    const show = { id: 'x-2026', title: 'A Woman Among Women', category: 'off-broadway' };
    assert.strictEqual(showScoreUrlForShow(show, {}), 'https://www.show-score.com/off-broadway-shows/a-woman-among-women');
  });

  it('constructs a broadway-shows URL for Broadway', () => {
    const show = { id: 'y-2026', title: 'Death of a Salesman', category: 'broadway' };
    assert.strictEqual(showScoreUrlForShow(show, {}), 'https://www.show-score.com/broadway-shows/death-of-a-salesman');
  });

  it('strips apostrophes/punctuation from the slug', () => {
    const show = { id: 'z', title: "Tony's Big Night!", category: 'off-broadway' };
    assert.strictEqual(showScoreUrlForShow(show, {}), 'https://www.show-score.com/off-broadway-shows/tonys-big-night');
  });

  it('returns null without a usable title', () => {
    assert.strictEqual(showScoreUrlForShow({ id: 'a' }, {}), null);
    assert.strictEqual(showScoreUrlForShow(null, {}), null);
  });
});

describe('extractShowScoreReviewUrls', () => {
  it('pulls JSON-LD url values and anchor hrefs, dropping Show Score own links', () => {
    const html = `
      <script type="application/ld+json">{"@type":"Review","url":"https://www.nytimes.com/2026/06/04/theater/girl-interrupted-review.html"}</script>
      <a href="https://www.vulture.com/article/theater-review-girl-interrupted.html">Vulture</a>
      <a href="https://www.show-score.com/off-broadway-shows/girl-interrupted">back to Show Score</a>
    `;
    const urls = extractShowScoreReviewUrls(html);
    assert.ok(urls.includes('https://www.nytimes.com/2026/06/04/theater/girl-interrupted-review.html'));
    assert.ok(urls.includes('https://www.vulture.com/article/theater-review-girl-interrupted.html'));
    assert.ok(!urls.some(u => /show-score\.com/.test(u)), 'must drop Show Score own links');
  });

  it('returns raw candidates including non-review links (caller filters)', () => {
    // The lib is intentionally permissive — ticketing/maps filtering is the
    // caller's job (isReviewUrl). Just verify it does not crash and de-dupes.
    const html = `<a href="https://maps.google.com/?q=1,2">map</a><a href="https://maps.google.com/?q=1,2">dup</a>`;
    const urls = extractShowScoreReviewUrls(html);
    assert.strictEqual(urls.filter(u => /maps\.google/.test(u)).length, 1, 'de-dupes');
  });

  it('handles empty/garbage input', () => {
    assert.deepStrictEqual(extractShowScoreReviewUrls(''), []);
    assert.deepStrictEqual(extractShowScoreReviewUrls(null), []);
  });
});

describe('extractReadMoreUrls — show-page-vouched links incl. opaque URLs', () => {
  it('pulls "Read more" hrefs, including title-less outlet URLs (L&SA)', () => {
    const html = `
      <a href="http://www.lightingandsoundamerica.com/news/story.asp?ID=TEZUG4">Read more</a>
      <a href="https://www.nytimes.com/2026/05/10/theater/the-receptionist-review.html">Read more</a>
      <a href="https://www.show-score.com/off-broadway-shows/the-receptionist">Read more</a>
    `;
    const urls = extractReadMoreUrls(html);
    assert.ok(urls.includes('http://www.lightingandsoundamerica.com/news/story.asp?ID=TEZUG4'),
      'opaque L&SA story.asp URL must survive (no title-match applied)');
    assert.ok(urls.some(u => /nytimes\.com/.test(u)));
    assert.ok(!urls.some(u => /show-score\.com/.test(u)));
  });
});

describe('parseShowScorePagination', () => {
  it('reads next-page-path and total-count', () => {
    const html = `<div data-next-page-path='/shows/the-receptionist/paginate_critic_reviews' data-total-count='13'>`;
    const p = parseShowScorePagination(html);
    assert.strictEqual(p.nextPagePath, '/shows/the-receptionist/paginate_critic_reviews');
    assert.strictEqual(p.totalCount, 13);
  });
  it('returns nulls when absent', () => {
    const p = parseShowScorePagination('<div>no pagination</div>');
    assert.strictEqual(p.nextPagePath, null);
    assert.strictEqual(p.totalCount, 0);
  });
});

describe('fetchAllShowScoreReviewUrls — paginates past the initial 8', () => {
  it('follows pagination and unions all pages', async () => {
    const page1 = `<div data-next-page-path='/shows/x/paginate_critic_reviews' data-total-count='11'>` +
      Array.from({ length: 8 }, (_, i) => `<a href="https://o${i}.com/r">a</a>Read more`).join('');
    const fetchHtml = async (u) => {
      if (!/paginate/.test(u)) return page1;
      if (/page=2/.test(u)) return JSON.stringify({ html: '<a href="https://o8.com/r">Read more</a><a href="https://o9.com/r">Read more</a><a href="https://o10.com/r">Read more</a>' });
      return JSON.stringify({ html: '' }); // page 3 empty → stop
    };
    const urls = await fetchAllShowScoreReviewUrls('https://www.show-score.com/off-broadway-shows/x', fetchHtml);
    assert.strictEqual(urls.length, 11, `expected 11 unique review URLs, got ${urls.length}`);
  });

  it('returns [] when the page fetch fails', async () => {
    const urls = await fetchAllShowScoreReviewUrls('https://x', async () => { throw new Error('boom'); });
    assert.deepStrictEqual(urls, []);
  });
});
