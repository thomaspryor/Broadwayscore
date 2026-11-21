// BRO-6580: roundup slug shapes that shipped as single-outlet reviews.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isRoundupUrl, isRoundupPageAsReview } = require('./review-guards.js');

const ROUNDUPS = [
  ['whatsonstage', 'https://www.whatsonstage.com/news/did-the-critics-enjoy-mrs-henderson-presents_39754/'],
  ['whatsonstage', 'https://www.whatsonstage.com/news/critics-split-over-simon-stephens-birdland_34116/'],
  ['whatsonstage', 'https://www.whatsonstage.com/news/high-society-splits-critics-at-old-vic_37819/'],
  ['whatsonstage', 'https://www.whatsonstage.com/london-theatre/news/how-to-hold-breath-maxine-peake-reviews_37136.html/'],
  ['standard', 'https://www.standard.co.uk/culture/theatre/bitter-wheat-reviews-roundup-john-malkovich-david-mamet-play-west-end-a4171856.html'],
  ['standard', 'https://www.standard.co.uk/culture/theatre/all-about-eve-reviews-round-up-gillian-anderson-lily-james-ivo-van-hove-a4065326.html'],
  ['playbill', 'https://playbill.com/article/playbill-theatre-week-in-review-april-14-20-critics-love-starcatcher-one-man-and-clybourne-park-com-199201'],
  ['playbill', 'https://playbill.com/article/playbillcoms-theatre-week-in-review-april-23-29-baby-its-you-house-of-blue-leaves-jerusalem-born-yesterday-and-more-com-178717'],
  ['broadwayworld', 'https://www.broadwayworld.com/translate/uk/Review-Roundup-GAME-OF-THRONES-THE-MAD-KING-is-Now-Playing-in-London-20260810'],
  ['daily-mail', 'https://www.dailymail.com/tvshowbiz/article-12222459/Lily-Allen-branded-unengaging-critics-gender-swapped-debut-Pillowman.html'],
  ['mail-on-sunday', 'https://www.dailymail.com/tvshowbiz/article-10860011/ABBA-Voyage-Critics-head-heels-bands-return-stage-London-residency.html'],
];

test('roundup articles stored under the host outlet are page-as-review', () => {
  for (const [outletId, url] of ROUNDUPS) {
    assert.equal(isRoundupUrl(url).isRoundup, true, url);
    assert.equal(isRoundupPageAsReview({ url, outletId }), true, url);
  }
});

test('the same hosts\' own reviews are untouched', () => {
  for (const [outletId, url] of [
    ['whatsonstage', 'https://www.whatsonstage.com/news/we-will-rock-you-review-its-already-defied-critics-so-does-anything-here-really-matter_1306755/'],
    ['whatsonstage', 'https://www.whatsonstage.com/news/1536-at-the-almeida-theatre-review_1677762/'],
    ['whatsonstage', 'https://www.whatsonstage.com/news/1984-playhouse-theatre_38092/'],
    ['standard', 'https://www.standard.co.uk/culture/theatre/all-about-eve-review-noel-coward-theatre-a4064950.html'],
    ['daily-mail', 'http://www.dailymail.co.uk/tvshowbiz/article-5204009/QUENTIN-LETTS-gives-verdict-Hamilton-West-End-hit.html'],
    ['broadwayworld', 'https://www.broadwayworld.com/boston/article/Review-A-Thrilling-BLACK-SWAN-at-American-Repertory-Theater-20260614'],
    ['playbill', 'https://playbill.com/article/on-the-record-the-light-in-the-piazza-and-little-women-com-126426'],
  ]) {
    assert.equal(isRoundupPageAsReview({ url, outletId }), false, url);
  }
});

test('a critic\'s review sourced from a roundup under another outlet still counts', () => {
  const url = ROUNDUPS[4][1];
  assert.equal(isRoundupPageAsReview({ url, outletId: 'guardian' }), false);
});

test('review follow-ups: other Mail sections, amp copies, regional WOS, critic bylines', () => {
  for (const u of [
    'https://www.dailymail.co.uk/lifestyle/article-14164837/The-Devil-Wears-Prada-musical-lambasted-critics.html',
    'https://www.dailymail.co.uk/tvshowbiz/article-12222459/amp/Lily-Allen-branded-unengaging-critics-Pillowman.html',
    'https://www.whatsonstage.com/edinburgh-theatre/news/did-the-critics-like-x_12345/',
  ]) assert.equal(isRoundupUrl(u).isRoundup, true, u);
  assert.equal(isRoundupUrl('https://www.dailymail.co.uk/tvshowbiz/article-1/PATRICK-MARMION-reviews-X-the-critics-darling.html').isRoundup, false);
});
