/**
 * Author-credit titles vs a closed bare-title production (cross-show URL guard).
 *
 * Clifford Odets' Waiting for Lefty (off-Broadway, opened 2026-11-02) lost
 * Vulture, a second NYSR review, Theater Pizzazz and Cititour on press night:
 * gather-reviews skipped each as crossShowUrl because the URLs carry
 * "waiting-for-lefty", the slug of Waiting for Lefty (regional, closed
 * 2024-02-24). The credit "Clifford Odets’" means it is the same play, and a
 * production that closed two years earlier can't own a 2026 review.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { detectCrossShowUrlMismatch, buildShowSlugIndex, creditedTitleSlug } = require('../../scripts/lib/cross-show-url.js');

const LEFTY = { id: 'clifford-odets-waiting-for-lefty-off-broadway-2026', title: 'Clifford Odets’ Waiting for Lefty', previewsStartDate: '2026-10-15', openingDate: '2026-11-02', closingDate: '2026-11-22' };
const OLD_LEFTY = { id: 'waiting-for-lefty-regional-2024', title: 'Waiting for Lefty', openingDate: '2024-02-04', closingDate: '2024-02-24' };
const MISSED = [
  'https://www.vulture.com/article/theater-reviews-waiting-for-lefty-odets-specky-clark-doherty.html',
  'https://nystagereview.com/2026/11/02/waiting-for-lefty-no-no-odets/',
  'https://theaterpizzazz.com/finally-waiting-for-lefty-has-arrived/',
  'https://cititour.com/NYC_Broadway/Waiting-for-Lefty/1408',
];

test('the four press-night reviews stay with the 2026 production, dated or not', () => {
  const index = buildShowSlugIndex([LEFTY, OLD_LEFTY]);
  for (const url of MISSED) {
    for (const publishDate of [undefined, '2026-11-02']) {
      assert.equal(detectCrossShowUrlMismatch(LEFTY.id, url, { index, publishDate }), null, `${url} (${publishDate})`);
    }
  }
});

test('a review dated inside the old run still belongs to the old production', () => {
  const index = buildShowSlugIndex([LEFTY, OLD_LEFTY]);
  const r = detectCrossShowUrlMismatch(LEFTY.id, 'https://example.com/2024/02/waiting-for-lefty-review/', { index, publishDate: '2024-02-10' });
  assert.equal(r && r.matchedShowId, OLD_LEFTY.id);
});

test('a still-running or undated same-title production keeps the guard', () => {
  const running = { id: 'waiting-for-lefty-regional-2026', title: 'Waiting for Lefty', openingDate: '2026-10-01' };
  const index = buildShowSlugIndex([LEFTY, running]);
  const r = detectCrossShowUrlMismatch(LEFTY.id, MISSED[2], { index, publishDate: '2026-11-02' });
  assert.equal(r && r.matchedShowId, running.id);
});

test('only real author credits count', () => {
  assert.equal(creditedTitleSlug('Clifford Odets’ Waiting for Lefty'), 'waiting-for-lefty');
  assert.equal(creditedTitleSlug("Irving Berlin's White Christmas"), 'white-christmas');
  assert.equal(creditedTitleSlug("Mel Brooks' Young Frankenstein"), 'young-frankenstein');
  for (const t of ["Hell's Kitchen", "The Band's Visit", "A Midsummer Night's Dream", "Jake's Women", "Our Country's Good", "Disney's Beauty and the Beast", 'Waiting for Lefty', "Neil Simon's Rumors"]) {
    assert.equal(creditedTitleSlug(t), null, t);
  }
});
