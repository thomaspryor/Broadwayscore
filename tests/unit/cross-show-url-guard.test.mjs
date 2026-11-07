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
// TESTS-VS-DERIVED-DATA-EXEMPT: the guard reads the live show index (shows.json titles, the hand-kept source of truth); the urls are fixed strings, not facts read back from reviews.json
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

// BRO-6910 replay: the live audit flagged 216 reviews (baseline 117). Most
// were a one-word title read as an ordinary word ("Lifeline" the Chicago
// company, "August" of August Wilson, "the heart" in "finds the heart behind")
// or a joint review whose url names this show too. Real rows from
// data/reviews.json, checked against the real show index.
test('BRO-6910: one-word titles and joint urls naming this show do not flag', () => {
  const quiet = [
    ['a-wrinkle-in-time-regional-2026', 'https://www.chicagotribune.com/2026/09/15/wrinkle-in-time-lifeline-theatre/', '2026-09-15'],
    ['loki-the-end-of-the-world-tour-regional-2026', 'https://www.chicagotribune.com/2026/06/01/review-loki-lifeline-theatre/', '2026-06-01'],
    ['crazysexycool-regional-2026', 'https://dctheaterarts.org/2026/06/28/crazysexycool-at-arena-stage-finds-the-heart-behind-tlcs-hits/', '2026-06-28'],
    ['beaches-2026', 'https://www.washingtonpost.com/entertainment/theater/2026/05/06/lost-boys-schmigadoon-beaches-broadway-review/', '2026-05-06'],
  ];
  for (const [showId, url, publishDate] of quiet) {
    assert.equal(detectCrossShowUrlMismatch(showId, url, { publishDate }), null, `${showId} <- ${url}`);
  }
});

test('BRO-6910: a one-word title in a title position still flags', () => {
  const hit = detectCrossShowUrlMismatch('harry-potter-and-the-cursed-child-both-parts-west-end-2021',
    'https://www.timeout.com/london/theatre/shadowlands-1-review', { publishDate: '2026-02-13' });
  assert.equal(hit?.matchedShowId, 'shadowlands-west-end-2026');
  const idx = buildShowSlugIndex([
    { id: 'schmigadoon-2026', title: 'Schmigadoon!' },
    { id: 'lifeline-off-west-end-2026', title: 'Lifeline' },
  ]);
  assert.equal(detectCrossShowUrlMismatch('schmigadoon-2026', 'https://example.com/theater/review-lifeline-at-the-gate/', { index: idx })?.matchedShowId, 'lifeline-off-west-end-2026');
  assert.equal(detectCrossShowUrlMismatch('schmigadoon-2026', 'https://example.com/theater/lifeline/', { index: idx })?.matchedShowId, 'lifeline-off-west-end-2026');
  assert.equal(detectCrossShowUrlMismatch('schmigadoon-2026', 'https://example.com/theater/a-lifeline-for-the-arts/', { index: idx }), null);
});

// Ship-check review of the fix above: a title opening a url segment is the
// common review slug and must keep flagging, and venue words from this show's
// id must not vouch. Accepted cost: a url opening "august-wilson-..." still
// flags a show titled August (one audit row, BRO-6910).
test('BRO-6910: a one-word title opening a url segment still flags; venue words never vouch', () => {
  for (const url of [
    'https://variety.com/2019/legit/reviews/hadestown-broadway-review-1236/',
    'https://www.theguardian.com/stage/hadestown-lyric-theatre-review',
    'https://www.thestage.co.uk/reviews/hadestown-at-the-lyric-theatre-review',
    'https://nypost.com/2019/04/17/hadestown-is-a-thrilling-revival/',
  ]) {
    assert.equal(detectCrossShowUrlMismatch('antigone-exits-chichester-regional-2026', url, {})?.matchedShowId, 'hadestown-2019', url);
  }
  assert.equal(detectCrossShowUrlMismatch('even-these-things-royal-exchange-regional-2026',
    'https://www.theguardian.com/stage/2026/the-crucible-review-royal-exchange-manchester', {})?.matchedShowId, 'the-crucible-2016');
});
