// BRO-6872: the lane bypasses the write path's nonReview / roundupUrlSwap guards, so the 2026-10 replays scored Gold
// Derby's critics roundups as Ethan Alter reviews of A Few Good Men and The Imaginary Invalid. The lane now runs the
// same shared detectors (lane-guards.js) on the fetched page before it pays a model, and treats a hit as a verdict.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { laneNonReviewReason } = require('../../scripts/lib/opening-night-lane/lane-guards.js');
const inl = require('../../scripts/lib/opening-night-lane/inline-score.js');
const trust = require('../../scripts/lib/opening-night-lane/trust-model.js');

const GOLD_DERBY = {
  afgmRoundup: 'https://www.goldderby.com/theater/2026/a-few-good-men-aaron-sorkin-bradley-whitford-broadway-revival-reviews/',
  iiRoundup: 'https://www.goldderby.com/theater/2026/the-imaginary-invalid-broadway-bill-irwin-reviews/',
  interview: 'https://www.goldderby.com/theater/2026/bill-irwin-imaginary-invalid-interview/',
};
const prov = (source) => ({ [trust.PROVENANCE_KEY]: { source } });

test('the three Gold Derby URLs are refused whichever adapter found them', () => {
  for (const source of ['aggregator', 'outlet-index']) {
    for (const [name, url] of Object.entries(GOLD_DERBY)) {
      const why = laneNonReviewReason({ url, outletId: 'goldderby', criticName: 'Ethan Alter', fullText: '', ...prov(source) });
      assert.ok(why, `${name} via ${source} must be refused`);
    }
  }
  assert.match(laneNonReviewReason({ url: GOLD_DERBY.afgmRoundup, outletId: 'goldderby' }), /roundup/);
  assert.match(laneNonReviewReason({ url: GOLD_DERBY.interview, outletId: 'goldderby' }), /named non-review/);
});

test('real reviews pass', () => {
  for (const [url, outletId] of [
    ['https://www.nytimes.com/2026/10/22/theater/imaginary-invalid-review-bill-irwin.html', 'nytimes'],
    ['https://www.goldderby.com/theater/2026/the-imaginary-invalid-review-bill-irwin/', 'goldderby'],
    ['https://www.the-independent.com/arts-entertainment/theatre-dance/reviews/a-few-good-men-review-b3075938.html', 'independent'],
  ]) assert.equal(laneNonReviewReason({ url, outletId, criticName: 'A Critic', fullText: 'One critic writes about the show at length.', ...prov('aggregator') }), null, url);
});

test('a page quoting several other outlets is a pull-quote compilation (the write path\'s E4 check)', () => {
  // The newyorktheater.me "critical consensus" fixture tests/unit/roundup-digest.test.mjs pins (attributions and
  // invented one-line blurbs; no review text).
  const fullText = 'A new production opened tonight at the August Wilson Theatre. That is the critical consensus, as indicated below: '
    + 'Helen Shaw, New York Times. A confident, unsettling piece of theater that earns its scares. '
    + 'Jackson McHenry, Vulture. The design team pulls off tricks that leave the audience gasping. '
    + "Howard Miller, Talkin' Broadway. A tightly wound thriller with a starry cast. "
    + 'Johnny Oleksinski, New York Post. Genuinely frightening in a way few Broadway shows manage. '
    + 'Frank Rizzo, Variety. A slick, well-drilled production that never quite finds its heart.';
  assert.match(laneNonReviewReason({ url: 'https://newyorktheater.me/2026/10/22/what-critics-said/', outletId: 'nyt-theater', criticName: 'Jonathan Mandell', fullText }) || '', /compilation/);
});

test('scoreReview refuses a Gold Derby roundup for good and never calls the scorer', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro6872-guard-'));
  try {
    let scorerCalls = 0;
    const scoring = inl.createInlineScoring({
      show: { id: 'the-imaginary-invalid-2026', title: 'The Imaginary Invalid', category: 'broadway' }, night: '2026-10-22',
      ledgerDir: path.join(dir, 'ledger'), now: () => Date.parse('2026-10-23T03:00:00Z'),
      fetchPage: async () => { throw new Error('unused'); }, extractArticle: () => null, extractMeta: () => ({}), aggregatorFor: () => ({}),
      scoreText: async () => { scorerCalls++; return { score: 70 }; },
    });
    const row = { url: GOLD_DERBY.iiRoundup, outletId: 'goldderby', criticName: 'Ethan Alter', fullText: 'x'.repeat(3000), ...prov('outlet-index') };
    await assert.rejects(scoring.scoreReview(row, {}), (e) => e instanceof inl.LanePermanentError && /not a review: roundup page/.test(e.message));
    await assert.rejects(scoring.scoreReview(row, {}), inl.LanePermanentError, 'a later pass does not retry it');
    assert.equal(scorerCalls, 0, 'no model was paid for the roundup');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a row with no outletId is still caught (outlet resolved from the url)', () => {
  assert.match(laneNonReviewReason({ url: GOLD_DERBY.iiRoundup.replace('www.', '') }), /roundup/);
});

test('an Independent roundup is still caught after the lane canonicalizes its host', () => {
  const { canonicalUrl } = require('../../scripts/lib/opening-night-lane/discovery.js');
  const raw = 'https://www.independent.co.uk/arts-entertainment/theatre-dance/reviews/cursed-child-reviews-roundup-b1234567.html';
  const canon = canonicalUrl(raw);
  assert.match(canon, /the-independent\.com/);
  assert.match(laneNonReviewReason({ url: canon, outletId: 'independent' }), /roundup/);
  assert.match(laneNonReviewReason({ url: raw, outletId: 'independent' }), /roundup/);
});

test('news about a show\'s reviews is refused on any host; real review slugs that say "reviews" are not (BRO-6872 replay)', () => {
  const news = 'https://showbiz411.com/2026/10/19/update-800-a-ticket-other-desert-cities-with-julia-louis-dreyfus-allison-janney-ed-harris-gets-disappointing-opening-night-reviews';
  for (const source of ['aggregator', 'outlet-index']) {
    assert.match(laneNonReviewReason({ url: news, outletId: 'showbiz411', criticName: 'Roger Friedman', fullText: '', ...prov(source) }), /reception-news-not-review/);
  }
  assert.match(laneNonReviewReason({ url: 'https://example.com/2026/10/30/a-few-good-men-draws-mixed-reviews/', fullText: '' }), /reception-news/);
  for (const url of [
    'https://www.nj.com/entertainment/2019/03/kiss-me-kate-never-gets-out-of-first-gear-but-be-more-chill-has-charm-broadway-reviews.html',
    'https://www.theatrely.com/post/gender-trouble-the-pass-hungry-women-review-roundup',
    'https://showbiz411.com/2026/10/19/other-desert-cities-review-julia-louis-dreyfus-allison-janney',
    // ship-check: a slug with its own "review" token, and "critics-reaction", are not reception news
    'https://example.com/broadway-review-hamlet-gets-good-reviews',
    'https://example.com/my-review-of-hamlet-pre-opening-night-reviews-embargo',
    'https://example.com/critics-reaction-to-the-tonys',
  ]) assert.equal(laneNonReviewReason({ url, fullText: '' }), null, url);
  // A BWW "Review-Roundup-Critics-React" page is the roundup guard's, not reception news.
  assert.match(laneNonReviewReason({ url: 'https://www.broadwayworld.com/article/Review-Roundup-Critics-React-to-HAMLET-20261020', fullText: '' }), /^roundup page/);
});
