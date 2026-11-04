/**
 * BRO-6921 follow-up: Times Square Chronicles and Gay City News had no feed (SERP
 * only), so reviews like TSC's "Phyl" were never found. Their WordPress category
 * feeds mix reviews with news that names the same shows, so feed matches on these
 * outlets must read as a review, and the SERP sweep keeps running beside the feed.
 * Headlines below are the real TSC titles (WP API, 2026-11-04).
 * Run: node --test tests/unit/outlet-mixed-feed.test.mjs
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  findMatchingShows,
  findPageConfirmCandidates,
  titleLedHeadline,
  itemReadsAsReview,
  titleForms,
} = require('../../scripts/lib/outlet-listing-helpers.js');
const poller = require('../../scripts/outlet-listing-poller.js');

const PHYL = { id: 'phyl-off-broadway-2026', title: 'Phyl', status: 'open', previewsStartDate: '2026-10-03', openingDate: '2026-10-22', closingDate: '2026-11-07' };
const MEMOIRS = { id: 'memoirs-of-amorous-gentlemen-off-broadway-2026', title: 'Memoirs of Amorous Gentlemen', status: 'open', previewsStartDate: '2026-09-25', openingDate: '2026-10-15', closingDate: '2027-01-03' };
const SCHOOL_GIRLS = { id: 'school-girls-or-the-african-mean-girls-play-2026', title: 'School Girls; Or, The African Mean Girls Play', status: 'open', previewsStartDate: '2026-09-08', openingDate: '2026-09-28', closingDate: '2026-11-15' };
const FEW_GOOD_MEN = { id: 'a-few-good-men-2026', title: 'A Few Good Men', status: 'open', previewsStartDate: '2026-10-08', openingDate: '2026-10-29', closingDate: '2027-01-10' };
const FENCES = { id: 'fences-off-west-end-2026', title: 'Fences', status: 'open', previewsStartDate: '2026-10-06', openingDate: '2026-10-09', closingDate: '2026-10-31' };
const GIRLS = { id: 'girls-off-west-end-2026', title: 'Girls', status: 'open', previewsStartDate: '2026-09-20', openingDate: '2026-09-30', closingDate: '2026-11-30' };
const KF_FIRST = { id: 'kramerfauci-off-broadway-2026', title: 'Kramer/Fauci', status: 'closed', openingDate: '2026-02-11', closingDate: '2026-02-21' };
const KF_RETURN = { id: 'kramerfauci-st-anns-off-broadway-2026', title: 'Kramer/Fauci', status: 'open', previewsStartDate: '2026-09-27', openingDate: '2026-10-04', closingDate: '2026-10-24' };

const TSC = (slug, headline, publishDate) => ({ url: `https://t2conline.com/${slug}/`, headline, publishDate });

describe('titleLedHeadline', () => {
  test('a headline that leads with the title (colon, possessive, quotes) reads as a review', () => {
    assert.equal(titleLedHeadline('Mint Theater Company&#8217;s Phyl: A Woman Ahead of Her Time', titleForms(PHYL)), true);
    assert.equal(titleLedHeadline('Memoirs of Amorous Gentlemen: A Beautifully Decadent World With a Star at Its Center', titleForms(MEMOIRS)), true);
    assert.equal(titleLedHeadline('School Girls; Or, The African Mean Girls Play: Being Made to Feel Ashamed of Your Skin Color', titleForms(SCHOOL_GIRLS)), true);
    assert.equal(titleLedHeadline('My View: “Phyl” at the Mint', titleForms(PHYL)), true);
  });
  test('news that only mentions the title does not', () => {
    assert.equal(titleLedHeadline('A Few Good Men Meets the Press: Michael Arden and Aaron Sorkin Return to the Truth', titleForms(FEW_GOOD_MEN)), false);
    assert.equal(titleLedHeadline('Memoirs of Amorous Gentlemen Offers a First Look at One of Duncan Sheik’s Final Musicals', titleForms(MEMOIRS)), false);
    assert.equal(titleLedHeadline('Tom Skerritt the Quiet Authority Behind Top Gun Alien and Picket Fences Dies at 93', titleForms(FENCES)), false);
    // A longer title that merely contains a short one is not that show.
    assert.equal(titleLedHeadline('School Girls; Or, The African Mean Girls Play: Being Made to Feel Ashamed of Your Skin Color', titleForms(GIRLS)), false);
  });
});

describe('itemReadsAsReview (the feed gate for mixed review/news feeds)', () => {
  const cases = [
    ['phyl review', TSC('mint-theater-companys-phyl-a-woman-ahead-of-her-time', 'Mint Theater Company&#8217;s Phyl: A Woman Ahead of Her Time', '2026-10-23'), PHYL, true],
    ['memoirs review', TSC('memoirs-of-amorous-gentlemen-a-beautifully-decadent-world-with-a-star-at-its-center', 'Memoirs of Amorous Gentlemen: A Beautifully Decadent World With a Star at Its Center', '2026-10-16'), MEMOIRS, true],
    ['memoirs first look (news)', TSC('memoirs-of-amorous-gentlemen-offers-a-first-look-at-one-of-duncan-sheiks-final-musicals', 'Memoirs of Amorous Gentlemen Offers a First Look at One of Duncan Sheik’s Final Musicals', '2026-09-22'), MEMOIRS, false],
    ['few good men press (news)', TSC('a-few-good-men-meets-the-press-michael-arden-and-aaron-sorkin-return-to-the-truth', 'A Few Good Men Meets the Press: Michael Arden and Aaron Sorkin Return to the Truth', '2026-10-07'), FEW_GOOD_MEN, false],
    ['obituary naming Picket Fences', TSC('tom-skerritt-the-quiet-authority-behind-top-gun-alien-and-picket-fences-dies-at-93', 'Tom Skerritt the Quiet Authority Behind Top Gun Alien and Picket Fences Dies at 93', '2026-10-23'), FENCES, false],
    ['School Girls review is not Girls', TSC('school-girls-or-the-african-mean-girls-play-being-made-to-feel-ashamed-of-your-skin-color', 'School Girls; Or, The African Mean Girls Play: Being Made to Feel Ashamed of Your Skin Color', '2026-10-03'), GIRLS, false],
    ['the word review still counts', TSC('review-fences-at-the-orange-tree', 'Review: Fences at the Orange Tree', '2026-10-12'), FENCES, true],
    ['a bare-title headline counts', TSC('phyl', 'Phyl', '2026-10-23'), PHYL, true],
  ];
  for (const [name, item, show, want] of cases) {
    test(name, () => assert.equal(itemReadsAsReview(item, show), want));
  }

  test('end to end: the gate drops what findMatchingShows wrongly files from news', () => {
    const shows = [FENCES, MEMOIRS, FEW_GOOD_MEN, GIRLS, SCHOOL_GIRLS];
    for (const [, item, show, want] of cases.filter(([, , , w]) => !w)) {
      const matched = findMatchingShows(item.headline, new URL(item.url).pathname, shows, '', { publishDate: item.publishDate });
      const kept = matched.filter((s) => itemReadsAsReview(item, s));
      assert.ok(!kept.some((s) => s.id === show.id), `${show.id} must not survive the gate`);
      assert.equal(want, false);
    }
  });
});

describe('page-confirm on titleLedReviews outlets', () => {
  const NOW = Date.parse('2026-10-24T11:00:00Z');
  test('Phyl is a candidate only when the outlet opts in', () => {
    const item = TSC('mint-theater-companys-phyl-a-woman-ahead-of-her-time', 'Mint Theater Company&#8217;s Phyl: A Woman Ahead of Her Time', '2026-10-23');
    assert.deepEqual(findPageConfirmCandidates(item, [PHYL], { nowMs: NOW }).map((c) => c.show.id), []);
    assert.deepEqual(findPageConfirmCandidates(item, [PHYL], { nowMs: NOW, titleLedReviews: true }).map((c) => c.show.id), [PHYL.id]);
  });
  test('a same-title earlier run outside the item date does not block the return run', () => {
    const item = TSC('kramer-fauci-review-st-anns', 'Kramer/Fauci: Two Men, One Plague', '2026-10-08');
    const ids = findPageConfirmCandidates(item, [KF_FIRST, KF_RETURN], { nowMs: Date.parse('2026-10-09T11:00:00Z'), titleLedReviews: true }).map((c) => c.show.id);
    assert.deepEqual(ids, [KF_RETURN.id]);
  });
  test('an undated item with two same-title runs stays ambiguous (no candidate)', () => {
    const item = { url: 'https://t2conline.com/kramer-fauci-two-men/', headline: 'Kramer/Fauci: Two Men, One Plague' };
    const ids = findPageConfirmCandidates(item, [KF_FIRST, KF_RETURN], { nowMs: Date.parse('2026-10-09T11:00:00Z'), titleLedReviews: true }).map((c) => c.show.id);
    assert.ok(!ids.includes(KF_FIRST.id) || !ids.includes(KF_RETURN.id));
  });
});

describe('poller config and WP fetch check', () => {
  test('TSC and Gay City News poll their WP feeds, gated, with SERP kept', () => {
    for (const id of ['times-square-chronicles', 'gay-city-news']) {
      const cfg = poller.WP_API_CONFIG[id];
      assert.ok(cfg && cfg.apiBase.includes('/wp-json/wp/v2/posts'), id);
      assert.equal(cfg.titleLedReviews, true, id);
      assert.equal(cfg.keepSerp, true, id);
    }
  });
  test('looksLikeWpPostList accepts a post array and rejects a bot challenge', () => {
    assert.equal(poller.looksLikeWpPostList('[{"link":"https://t2conline.com/x/"}]'), true);
    assert.equal(poller.looksLikeWpPostList('[]'), true);
    assert.equal(poller.looksLikeWpPostList('<html><title>Robot Challenge Screen</title></html>'), false);
    assert.equal(poller.looksLikeWpPostList('{"code":"rest_no_route"}'), false);
  });
});

describe('a title inside a longer matched title', () => {
  const TWO_GIRLS = { id: 'two-girls-off-broadway-2026', title: 'Two Girls', status: 'open', previewsStartDate: '2026-10-01', openingDate: '2026-10-15' };
  test('"Two Girls" review files to Two Girls only, not Girls', () => {
    const ids = findMatchingShows('Review: Two Girls, an Interrogation of a Memory of a Brazilian Porno',
      '/news/review-two-girls-an-interrogation-of-a-memory-of-a-brazilian-porno_1857490/', [GIRLS, TWO_GIRLS], '', { publishDate: '2026-10-20' }).map((s) => s.id);
    assert.deepEqual(ids, [TWO_GIRLS.id]);
  });
  test('two distinct titles in one headline still both match', () => {
    const ids = findMatchingShows('A Few Good Men and Memoirs of Amorous Gentlemen review', '/x/', [FEW_GOOD_MEN, MEMOIRS], '', { publishDate: '2026-10-23' }).map((s) => s.id);
    assert.deepEqual(ids.sort(), [MEMOIRS.id, FEW_GOOD_MEN.id].sort());
  });
});

test('a short title mentioned on its own besides a longer one still matches', () => {
  const TWO_GIRLS = { id: 'two-girls-off-broadway-2026', title: 'Two Girls', status: 'open', previewsStartDate: '2026-10-01', openingDate: '2026-10-15' };
  const ids = findMatchingShows('Girls and Two Girls: a double bill review', '/x/', [GIRLS, TWO_GIRLS], '', { publishDate: '2026-10-20' }).map((s) => s.id);
  assert.deepEqual(ids.sort(), [GIRLS.id, TWO_GIRLS.id].sort());
});
