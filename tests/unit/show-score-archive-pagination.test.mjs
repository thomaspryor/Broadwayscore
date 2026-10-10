/**
 * Show Score archive pagination (2026 data audit, BRO-4204 S7-T9).
 *
 * data/audit/show-score-extraction-gaps.json had 361 rows, 357 of them
 * `extracted: 8` (24 of them 2026 shows; bug-2026 = 8 of 19): Show Score
 * server-renders exactly 8 critic tiles and loads 9..N from
 * /shows/{slug}/paginate_critic_reviews?page=N only on a click of the
 * carousel's next arrow — never on scroll — so fetch-aggregator-pages.ts's
 * scroll loop archived 8 tiles for every show with more. The renderer now
 * calls the pagination endpoint from the page context and appends the tiles
 * before saving; the page list comes from showScorePaginationPages, the real
 * helper require()d here (CLAUDE.md §15).
 *
 * Run: node --test tests/unit/show-score-archive-pagination.test.mjs
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.join(import.meta.dirname, '..', '..');
const {
  showScorePaginationPages,
  parseShowScorePagination,
  fetchAllShowScoreReviewUrls,
} = require(path.join(ROOT, 'scripts/lib/show-score-discover.js'));

// The critic block exactly as the live bug-2026 page serves it (2026-09-28).
const BUG_INITIAL = `<div class='scrollable-block js-scrollable-block js-show-page-v2__critic-reviews -with-margin-bottom' data-next-page-path='/shows/bug-broadway/paginate_critic_reviews' data-steps='{&quot;default&quot;:2}' data-total-count='19'>
<div class='scrollable-block__elements js-scrollable-block__elements'>
${[1, 2, 3, 4, 5, 6, 7, 8].map((i) => `<div class='scrollable-block__element js-scrollable-block__element'><div class='review-tile-v2 -critic' id='critic_review_${i}'><a href="https://outlet${i}.example/review" target="_blank">Read more</a></div></div>`).join('\n')}
</div></div>`;
const page = (ids) => JSON.stringify({ html: ids.map((i) => `<div class='scrollable-block__element js-scrollable-block__element'><div class='review-tile-v2 -critic' id='critic_review_${i}'><a href="https://outlet${i}.example/review">Read more</a></div></div>`).join('\n') });

describe('showScorePaginationPages', () => {
  test('bug-2026: 19 critics → pages 2, 3 and the empty safety page 4', () => {
    assert.deepEqual(showScorePaginationPages(19), [2, 3, 4]);
    assert.deepEqual(showScorePaginationPages('19'), [2, 3, 4]);
  });

  test('8 or fewer → nothing to fetch; 9 → pages 2 and 3; 44 (Hamilton) → 2..7', () => {
    assert.deepEqual(showScorePaginationPages(8), []);
    assert.deepEqual(showScorePaginationPages(0), []);
    assert.deepEqual(showScorePaginationPages(9), [2, 3]);
    assert.deepEqual(showScorePaginationPages(44), [2, 3, 4, 5, 6, 7]);
  });

  test('garbage counts → []', () => {
    assert.deepEqual(showScorePaginationPages(null), []);
    assert.deepEqual(showScorePaginationPages('many'), []);
    assert.deepEqual(showScorePaginationPages(NaN), []);
  });

  test('the real pagination attributes parse from the single-quoted live block', () => {
    assert.deepEqual(parseShowScorePagination(BUG_INITIAL), { nextPagePath: '/shows/bug-broadway/paginate_critic_reviews', totalCount: 19 });
  });
});

describe('fetchAllShowScoreReviewUrls uses the shared page list', () => {
  test('follows pages 2..4 for 19 critics and stops at the empty terminator', async () => {
    const requested = [];
    const fetchHtml = async (url) => {
      requested.push(url);
      if (url.endsWith('bug-broadway')) return BUG_INITIAL;
      if (url.endsWith('page=2')) return page([9, 10, 11, 12, 13, 14, 15, 16]);
      if (url.endsWith('page=3')) return page([17, 18, 19]);
      return JSON.stringify({ html: ' ' });
    };
    const urls = await fetchAllShowScoreReviewUrls('https://www.show-score.com/broadway-shows/bug-broadway', fetchHtml);
    assert.equal(urls.length, 19);
    assert.deepEqual(requested.slice(1), [2, 3, 4].map((p) => `https://www.show-score.com/shows/bug-broadway/paginate_critic_reviews?page=${p}`));
  });
});

describe('fetch-aggregator-pages.ts wiring', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/fetch-aggregator-pages.ts'), 'utf8');

  test('renders tiles 9..N through the pagination endpoint, not a scroll loop', () => {
    assert.match(src, /require\('\.\/lib\/show-score-discover'\)/, 'must use the real helper');
    assert.match(src, /const \{ nextPagePath, totalCount \} = parseShowScorePagination\(html\);/);
    assert.match(src, /showScorePaginationPages\(Math\.max\(totalCount, expectedCount\)\)/);
    assert.match(src, /fetch\(`\$\{nextPagePath\}\?page=\$\{p\}`/, 'must call the site\'s own pagination endpoint from the page context');
    assert.match(src, /container\.appendChild\(/, 'must append the returned tiles before page.content()');
    assert.ok(!/el\.scrollLeft = el\.scrollWidth/.test(src), 'the scroll-to-load loop that never triggered a pagination request must be gone');
    const appendAt = src.indexOf('container.appendChild(');
    const captureAt = src.indexOf('html = await page.content();', appendAt);
    assert.ok(appendAt > 0 && captureAt > appendAt, 'HTML must be re-captured AFTER the tiles are appended');
  });
});
