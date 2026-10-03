// BRO-4546: SERP rediscovery swapped review-slugged URLs for same-outlet news,
// profile and box-office articles (173 files measured 2026-10-03). The guard
// compares the candidate against the URL it would replace.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { evaluateSerpAcceptance: ev, hasReviewPathToken, downgradeBaselineUrl } = require('../../scripts/lib/serp-review-acceptance.js');
const { evaluateFile, normUrl } = require('../../scripts/scan-serp-adoptions.js');

const THR = 'https://www.hollywoodreporter.com/';
const CASES = [
  // [show, previous review URL, swapped-in non-review]
  ['The Outsiders', THR + 'lifestyle/arts/the-outsiders-broadway-review-1235874615/', THR + 'business/business-news/broadway-box-office-merrily-we-roll-along-the-outsiders-stereophonic-tonys-1235932050/'],
  ['A Strange Loop', THR + 'lifestyle/arts/a-strange-loop-broadway-review-1235148419/', THR + 'lifestyle/arts/a-strange-loop-closing-broadway-1235283311/'],
  ['Disaster!', 'https://www.vulture.com/2016/02/theater-review-disaster.html', 'https://www.vulture.com/2016/03/theater-white-rabbit-red-rabbit.html'],
  ['Come From Away', 'https://observer.com/2017/03/come-from-away-broadway-review/', 'https://observer.com/2017/03/come-from-away-broadway-theater-profile-chad-kimball-jenn-colella/'],
  ['Anastasia', 'https://observer.com/2017/04/anastasia-broadway-review-christy-altomare/', 'https://observer.com/2017/04/derek-klena-brings-your-childhood-crush-to-broadway-in-anastasia/'],
  ['Evita', 'http://www.huffingtonpost.com/2012/04/05/evita-review-ricky-martin_n_1407387.html', 'https://www.huffpost.com/entry/theater-do-cry-for-evita_b_1418473'],
  ['MJ', 'https://variety.com/2022/legit/reviews/mj-the-musical-review-1235039497/', 'https://au.variety.com/2025/music/news/mj-the-musical-sydney-cast/'],
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

test('aggregator/other-host previous URL cannot veto; a "Review" SERP title outranks the slug', () => {
  // wrong_content recovery: stored url is a BWW roundup, the outlet review is slugless
  assert.equal(ev({ url: 'https://www.newyorker.com/magazine/2018/03/26/will-the-mean-girls-musical-make-fetch-happen', showTitle: 'Mean Girls', previousUrl: 'https://www.broadwayworld.com/article/Review-Roundup-MEAN-GIRLS-Opens-on-Broadway-20180408' }).ok, true);
  // different outlet entirely: cross-outlet guards own that case
  assert.equal(ev({ url: 'https://www.theguardian.com/stage/2024/oct/02/fleetwood-mac-stereophonic', showTitle: 'Stereophonic', previousUrl: 'https://observer.com/2024/04/stereophonic-broadway-review/' }).reason === 'review-slug-downgrade', false);
  // same host but the previous URL is itself a roundup
  assert.equal(ev({ url: 'https://www.whatsonstage.com/shows/london-theatre/west-end-theatre/jesus-christ-superstar_1721464/', showTitle: 'Jesus Christ Superstar', previousUrl: 'https://www.whatsonstage.com/news/did-sam-ryder-reach-for-the-stars-jesus-christ-superstar-review-round-up_1726870/' }).reason === 'review-slug-downgrade', false);
  assert.equal(ev({ url: CASES[2][2], showTitle: 'Disaster!', previousUrl: CASES[2][1], title: 'Theater Review: Disaster! and White Rabbit Red Rabbit' }).ok, true);
  // plural "reviews" headline is a roundup, not a review
  assert.equal(ev({ url: CASES[0][2], showTitle: 'The Outsiders', previousUrl: CASES[0][1], title: "'The Outsiders' reviews: what critics say" }).reason, 'review-slug-downgrade');
});

test('a url flagged as the wrong article is not a downgrade baseline (retry paths pass the bad url)', () => {
  const url = 'https://www.nystagereview.com/2022/12/15/aint-no-mo-satirical-beauty/';
  for (const flag of ['wrongUrl', 'wrongShow', 'wrongProduction', 'showNotMentioned', 'fabricatedEntry', 'isRoundupArticle']) {
    assert.equal(downgradeBaselineUrl({ url, [flag]: true }), undefined, flag);
  }
  assert.equal(downgradeBaselineUrl({ url, contentVerification: { wrongArticle: true } }), undefined);
  assert.equal(downgradeBaselineUrl({ url, incompleteReason: 'stale_wrong_production' }), undefined);
  // fetch failures keep the baseline: this is the reason-recovery path behind BRO-4546
  assert.equal(downgradeBaselineUrl({ url, incompleteReason: 'wrong_content' }), url);
  assert.equal(downgradeBaselineUrl({ url: '' }), undefined);
});

test('url-discovery wires the baseline helper, not raw review.url', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../scripts/lib/url-discovery.js', import.meta.url), 'utf8');
  assert.match(src, /previousUrl: downgradeBaselineUrl\(review\)/);
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

test('scanner url ownership key ignores scheme, www, query, fragment and trailing slash', () => {
  assert.equal(normUrl('http://www.Thewrap.com/x/cats-review/?utm=1#a'), normUrl('https://thewrap.com/x/cats-review'));
  assert.notEqual(normUrl('https://thewrap.com/x/cats-review'), normUrl('https://thewrap.com/x/cats-review-2'));
});
