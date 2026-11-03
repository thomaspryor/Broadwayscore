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

// BRO-6909: short titles (< 8 chars) are outside the slug index.
test('a short title loses a URL only to a longer title playing that year', () => {
  const GIRLS = { id: 'girls-off-west-end-2026', title: 'Girls', openingDate: '2026-10-27' };
  const MEAN = { id: 'mean-girls-regional-2026', title: 'Mean Girls', openingDate: '2026-09-01', closingDate: '2026-12-01' };
  const VANYA = { id: 'vanya-west-end-2023', title: 'Vanya', openingDate: '2023-09-21', closingDate: '2023-10-21' };
  const UNCLE = { id: 'uncle-vanya-2024', title: 'Uncle Vanya', openingDate: '2024-04-24', closingDate: '2024-06-16' };
  const AND = { id: 'and-juliet-tour-2024', title: '& Juliet', openingDate: '2024-10-01' };
  const ROMEO = { id: 'drunk-romeo-and-juliet-off-broadway-2025', title: 'Drunk Romeo & Juliet', openingDate: '2025-06-01' };
  const FENCES = { id: 'fences-x', title: 'Fences', openingDate: '2026-01-01' };
  const WILSON = { id: 'august-wilsons-fences-x', title: "August Wilson's Fences", openingDate: '2026-01-01' };
  const shows = [GIRLS, MEAN, VANYA, UNCLE, AND, ROMEO, FENCES, WILSON];
  const index = buildShowSlugIndex(shows);
  const d = (id, url, publishDate) => detectCrossShowUrlMismatch(id, url, { index, shows, publishDate });
  assert.equal(d(GIRLS.id, 'https://northwestend.com/mean-girls-liverpool-empire/', '2026-10-20')?.matchedShowId, MEAN.id);
  // own bare mention vouches; undated never flags
  assert.equal(d(GIRLS.id, 'https://x.com/girls-young-vic-review-not-mean-girls/', '2026-10-28'), null);
  assert.equal(d(GIRLS.id, 'https://northwestend.com/mean-girls-liverpool-empire/', undefined), null);
  // Time Out reused ".../uncle-vanya-20-review" for Vanya (2023): no Uncle Vanya that year
  assert.equal(d(VANYA.id, 'https://www.timeout.com/london/theatre/uncle-vanya-20-review', '2023-09-22'), null);
  // "& Juliet" slugs to "juliet": words in front are its own title
  assert.equal(d(AND.id, 'https://x.com/who-needs-romeo-juliet-brings-joy/', '2025-07-01'), null);
  // a credit in front is the same play
  assert.equal(d(FENCES.id, 'https://x.com/august-wilsons-fences-review/', '2026-02-01'), null);
});
