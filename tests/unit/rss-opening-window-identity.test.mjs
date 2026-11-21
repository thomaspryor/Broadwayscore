// task #1073: openingWindow RSS feeds must pass an IDENTITY check (title or
// URL slug), not date proximity alone. Before this gate, every NYT-Theater /
// Variety-Legit item published ±2 days of an opening was attributed to that
// show — 8 NYT obituaries/news stubs landed in _pending/the-vessel-off-
// broadway-2026 and an Oh Mary article in _pending/the-pass-off-broadway-2026
// (2026-08-05). Tests require() the real functions (CLAUDE.md §15).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { titleMatchesShow, urlSlugMatchesShow, isWithinOpeningWindow, openingWindowFeedAccepts, singleBylineName, parseFeedItems } = require('../../scripts/lib/rss-discovery.js');

test('urlSlugMatchesShow: NYT review slug matches show title', () => {
  assert.equal(urlSlugMatchesShow(
    'https://www.nytimes.com/2026/08/04/theater/the-vessel-review-suicide-intervention-squad.html',
    'The Vessel'), true);
  assert.equal(urlSlugMatchesShow(
    'https://www.nytimes.com/2026/08/04/theater/disruption-review-john-david-washington.html',
    'Disruption'), true);
});

test('urlSlugMatchesShow: single-word titles need the full phrase, not a stray token (Codex finding)', () => {
  // "pass" token inside an unrelated slug must NOT match The Pass.
  assert.equal(urlSlugMatchesShow(
    'https://www.thewrap.com/creative-content/movies/gail-daughtry-and-the-celebrity-sex-pass-review-sundance/',
    'The Pass'), false);
  // The real review slug still matches — full phrase "the pass" is contiguous.
  assert.equal(urlSlugMatchesShow(
    'https://newyorktheater.me/2026/08/03/the-pass-review-a-heated-rivalry/',
    'The Pass'), true);
});

test('urlSlugMatchesShow: unrelated theater-section articles do NOT match', () => {
  const vesselJunk = [
    'https://www.nytimes.com/2026/07/25/theater/kenneth-branagh-royal-shakespeare-company.html',
    'https://www.nytimes.com/2026/07/28/theater/lilly-yokoi-dead.html',
    'https://www.nytimes.com/2026/07/31/theater/boy-george-israel.html',
    'https://variety.com/2026/legit/news/elf-lyons-solo-show-woman-on-the-edge-new-york-1236822695/',
  ];
  for (const u of vesselJunk) {
    assert.equal(urlSlugMatchesShow(u, 'The Vessel'), false, u);
  }
  assert.equal(urlSlugMatchesShow(
    'https://www.nytimes.com/2026/08/04/theater/bowen-yang-broadway-oh-mary.html',
    'The Pass'), false);
});

test('the combined openingWindow gate: date window alone is NOT sufficient', () => {
  // Simulates checkRSSFeeds' new acceptance for openingWindow feeds:
  // within-window AND (title-match OR slug-match).
  const opening = '2026-07-30';
  const pub = new Date('2026-07-31T12:00:00Z');
  const accept = (itemTitle, link, showTitle) =>
    isWithinOpeningWindow(pub, opening, 2) &&
    (titleMatchesShow(itemTitle, showTitle) || urlSlugMatchesShow(link, showTitle));

  // Real review: stylized headline but slug carries the title → accepted.
  assert.equal(accept(
    'Review: A Suicide Intervention Squad, Underground',
    'https://www.nytimes.com/2026/08/04/theater/the-vessel-review-suicide-intervention-squad.html',
    'The Vessel'), true);
  // Obituary published in-window → rejected on identity.
  assert.equal(accept(
    'Lilly Yokoi, Ballerina of the Bicycle, Dies',
    'https://www.nytimes.com/2026/07/28/theater/lilly-yokoi-dead.html',
    'The Vessel'), false);
  // In-window Oh Mary article vs The Pass → rejected on identity.
  assert.equal(accept(
    'Bowen Yang Will Make His Broadway Debut in Oh, Mary!',
    'https://www.nytimes.com/2026/08/04/theater/bowen-yang-broadway-oh-mary.html',
    'The Pass'), false);
});

// BRO-4435: the NYT Degenerates review (opening 2026-09-28) was posted
// 2026-09-30T09:02Z, 2.38 elapsed days after UTC midnight, and was dropped.
test('openingWindowFeedAccepts: NYT review posted day +2 mid-morning is accepted', () => {
  assert.equal(openingWindowFeedAccepts({
    title: 'Critic\u2019s Pick: \u2018Degenerates\u2019 Unmasks the Longing Disguised as Hate',
    link: 'https://www.nytimes.com/2026/09/30/theater/degenerates-review-the-longing-beneath-the-hate-and-self-hate.html',
    pubDate: new Date('2026-09-30T09:02:17Z'),
  }, 'Degenerates', '2026-09-28'), true);
});

test('openingWindowFeedAccepts: days +3..+7 need a review marker, +8 is out', () => {
  const review = { title: "'Degenerates' Review: Lonely Men", link: 'https://www.nytimes.com/2026/10/03/theater/degenerates-review.html', pubDate: new Date('2026-10-03T10:00:00Z') };
  const news = { title: "'Degenerates' Extends Its Run", link: 'https://www.nytimes.com/2026/10/03/theater/degenerates-extension.html', pubDate: new Date('2026-10-03T10:00:00Z') };
  assert.equal(openingWindowFeedAccepts(review, 'Degenerates', '2026-09-28'), true);
  assert.equal(openingWindowFeedAccepts(news, 'Degenerates', '2026-09-28'), false);
  assert.equal(openingWindowFeedAccepts({ ...review, pubDate: new Date('2026-10-06T10:00:00Z') }, 'Degenerates', '2026-09-28'), false);
});

test('openingWindowFeedAccepts: in-window item without identity match is rejected', () => {
  assert.equal(openingWindowFeedAccepts({
    title: 'Duncan Sheik, Who Traded Pop Stardom for Broadway, Dies at 56',
    link: 'https://www.nytimes.com/2026/09/29/theater/duncan-sheik-dead.html',
    pubDate: new Date('2026-09-29T12:00:00Z'),
  }, 'Degenerates', '2026-09-28'), false);
});

test('parseFeedItems reads dc:creator; singleBylineName keeps single-person bylines only', () => {
  const xml = '<rss><channel><item><title>Critic\u2019s Pick: \u2018Degenerates\u2019</title>'
    + '<link>https://www.nytimes.com/2026/09/30/theater/degenerates-review.html</link>'
    + '<dc:creator>Helen Shaw</dc:creator><pubDate>Wed, 30 Sep 2026 09:02:17 +0000</pubDate></item></channel></rss>';
  const [item] = parseFeedItems(xml);
  assert.equal(item.creator, 'Helen Shaw');
  assert.equal(singleBylineName(item.creator), 'Helen Shaw');
  assert.equal(singleBylineName('By Jesse Green'), 'Jesse Green');
  assert.equal(singleBylineName('Jesse Green and Laura Collins-Hughes'), null);
  assert.equal(singleBylineName('Staff'), null);
  assert.equal(singleBylineName(''), null);
  for (const org of ['The Associated Press', 'Variety Staff', 'Staff Reporter', 'Gordon Cox Contributor', 'NYT Editors']) {
    assert.equal(singleBylineName(org), null, org);
  }
  const multi = '<rss><channel><item><title>X Review</title><link>https://variety.com/2026/legit/reviews/x-review/</link>'
    + '<dc:creator>Aramide Tinubu</dc:creator><dc:creator>Chris Willman</dc:creator></item></channel></rss>';
  assert.equal(parseFeedItems(multi)[0].creator, '');
});
