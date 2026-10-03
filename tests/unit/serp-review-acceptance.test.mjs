// BRO-4546: SERP rediscovery swapped review-slugged URLs for same-outlet news,
// profile and box-office articles (173 files measured 2026-10-03). The guard
// compares the candidate against the URL it would replace.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { evaluateSerpAcceptance: ev, hasReviewPathToken } = require('../../scripts/lib/serp-review-acceptance.js');
const { evaluateFile } = require('../../scripts/scan-serp-adoptions.js');

const THR = 'https://www.hollywoodreporter.com/';
const CASES = [
  // [show, previous review URL, swapped-in non-review]
  ['The Outsiders', THR + 'lifestyle/arts/the-outsiders-broadway-review-1235874615/', THR + 'business/business-news/broadway-box-office-merrily-we-roll-along-the-outsiders-stereophonic-tonys-1235932050/'],
  ['A Strange Loop', THR + 'lifestyle/arts/a-strange-loop-broadway-review-1235148419/', THR + 'lifestyle/arts/a-strange-loop-closing-broadway-1235283311/'],
  ['Disaster!', 'https://www.vulture.com/2016/02/theater-review-disaster.html', 'https://www.vulture.com/2016/03/theater-white-rabbit-red-rabbit.html'],
  ['Come From Away', 'https://observer.com/2017/03/come-from-away-broadway-review/', 'https://observer.com/2017/03/come-from-away-broadway-theater-profile-chad-kimball-jenn-colella/'],
  ['Anastasia', 'https://observer.com/2017/04/anastasia-broadway-review-christy-altomare/', 'https://observer.com/2017/04/derek-klena-brings-your-childhood-crush-to-broadway-in-anastasia/'],
  ['Waiting for Godot', 'https://www.nytimes.com/2009/04/01/theater/reviews/01godot.html', 'https://www.nytimes.com/2009/04/19/theater/19mcgr.html'],
];

for (const [showTitle, previousUrl, url] of CASES) {
  test(`refuses review-slug downgrade for ${showTitle}`, () => {
    assert.deepEqual(ev({ url, showTitle, previousUrl }), { ok: false, reason: 'review-slug-downgrade' });
  });
}

test('THR box-office piece still passes the stateless predicate (why previousUrl is needed)', () => {
  assert.equal(ev({ url: CASES[0][2], showTitle: 'The Outsiders' }).ok, true);
});

test('allows review -> review swaps and adoptions with no previous URL', () => {
  assert.equal(ev({ url: THR + 'lifestyle/arts/the-outsiders-broadway-review-1235874615/', showTitle: 'The Outsiders', previousUrl: 'https://www.hollywoodreporter.com/news/the-outsiders-review-123/' }).ok, true);
  assert.equal(ev({ url: CASES[0][2], showTitle: 'The Outsiders', previousUrl: '' }).ok, true);
  // previous URL had no review token: no downgrade to detect
  assert.equal(ev({ url: 'https://www.washingtonpost.com/theater-dance/2023/04/13/camelot-sher-soo-aaron-sorkin/', showTitle: 'Camelot', previousUrl: 'https://www.washingtonpost.com/theater-dance/2023/04/14/camelot-broadway/' }).ok, true);
});

test('review path token: segment and slug word, not substrings', () => {
  assert.equal(hasReviewPathToken('https://www.nytimes.com/2009/04/01/theater/reviews/01godot.html'), true);
  assert.equal(hasReviewPathToken('https://www.vulture.com/2011/03/theater_review_that_champions.html'), true);
  assert.equal(hasReviewPathToken('https://www.timeout.com/newyork/theater/oslo-review'), true);
  assert.equal(hasReviewPathToken('https://example.com/reviewing-the-season'), false);
  assert.equal(hasReviewPathToken('https://example.com/theater/preview-week'), false);
  assert.equal(hasReviewPathToken('https://example.com/a?type=review'), false);
});

test('scan-serp-adoptions passes previousUrl; URL-bound verification stamp exempts only that url', () => {
  const [, previousUrl, url] = CASES[0];
  const data = { urlDiscoveryMethod: 'google-serp-reason-recovery', url, previousUrl };
  assert.equal(evaluateFile(data, 'The Outsiders').reason, 'review-slug-downgrade');
  assert.equal(evaluateFile({ ...data, serpDowngradeVerifiedUrl: url }, 'The Outsiders').ok, true);
  assert.equal(evaluateFile({ ...data, serpDowngradeVerifiedUrl: 'https://other/' }, 'The Outsiders').ok, false);
});
