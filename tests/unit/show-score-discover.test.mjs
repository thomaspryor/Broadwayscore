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
const { showScoreUrlForShow, extractShowScoreReviewUrls } = require('../../scripts/lib/show-score-discover.js');

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
