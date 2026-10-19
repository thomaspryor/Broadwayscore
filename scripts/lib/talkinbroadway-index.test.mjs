import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  titleFromLinkText, normalizeTbUrl, isReviewHref, normalizeTitle, extractReviewLinks, titleFromPageTitle,
  matchShowByTitle, heldKey, planCollection, pickCriticForShow, pageTitleMatchesShow,
} = require('./talkinbroadway-index.js');

const NOW = new Date('2026-10-19T12:00:00Z');
const shows = [
  { id: 'good-time-charlie-off-broadway-2026', title: 'Good Time Charlie', openingDate: '2026-10-09', market: 'broadway' },
  { id: 'the-ask-off-broadway-2026', title: 'The Ask', openingDate: '2026-10-15', market: 'broadway' },
  { id: 'old-play-off-broadway-2019', title: 'Old Play', openingDate: '2019-03-01', market: 'broadway' },
  { id: 'twin-a-2026', title: 'Twin', openingDate: '2026-10-10', market: 'broadway' },
  { id: 'twin-b-2026', title: 'Twin', openingDate: '2026-10-12', market: 'broadway' },
  { id: 'london-only-west-end-2026', title: 'London Only', openingDate: '2026-10-12', market: 'west-end' },
];

test('review hrefs: day pages and title pages are reviews, nav and share links are not', () => {
  assert.equal(isReviewHref('/page/ob/10_09_26.html'), true);
  assert.equal(isReviewHref('/page/world/OtherDesertCities26.html'), true);
  assert.equal(isReviewHref('https://www.talkinbroadway.com/page/bwaybway/05_03_26.html'), true);
  for (const bad of ['/page/world/index.html', '/page/ob/past.html', '/page/regional/minn/minn1534.html',
    'https://www.facebook.com/sharer/sharer.php?u=https://www.talkinbroadway.com/page/ob/10_09_26.html',
    'https://example.com/page/ob/10_09_26.html', '', null]) {
    assert.equal(isReviewHref(bad), false, String(bad));
  }
});

test('normalizeTbUrl drops query, hash and the www difference', () => {
  assert.equal(normalizeTbUrl('http://talkinbroadway.com/page/ob/10_09_26.html?x=1#top'), 'https://www.talkinbroadway.com/page/ob/10_09_26.html');
  assert.equal(normalizeTbUrl('/page/ob/10_09_26.html'), 'https://www.talkinbroadway.com/page/ob/10_09_26.html');
  assert.equal(normalizeTbUrl('https://nytimes.com/x.html'), null);
});

test('normalizeTitle ignores case, punctuation, accents and a leading article', () => {
  assert.equal(normalizeTitle('The Ask'), normalizeTitle('ask'));
  assert.equal(normalizeTitle("Joe Turner's Come & Gone"), normalizeTitle('joe turner s come and gone'));
  assert.equal(normalizeTitle('Café'), 'cafe');
});

test('extractReviewLinks keeps review anchors once and drops nav', () => {
  const anchors = [
    { href: '/page/world/index.html', text: 'Broadway reviews' },
    { href: '/page/ob/10_09_26.html', text: ' Good Time  Charlie ' },
    { href: '/page/ob/10_09_26.html', text: 'Good Time Charlie' },
    { href: '/page/regional/boston/index.html', text: '» Boston' },
  ];
  assert.deepEqual(extractReviewLinks(anchors), [{ url: 'https://www.talkinbroadway.com/page/ob/10_09_26.html', text: 'Good Time Charlie' }]);
});

test('titleFromPageTitle reads the quoted show title', () => {
  assert.equal(titleFromPageTitle('Talkin\' Broadway Off-Broadway - "Good Time Charlie" - 10/9/26'), 'Good Time Charlie');
  assert.equal(titleFromPageTitle('Talkin\' Broadway - Off Broadway Past Reviews'), null);
});

test('matchShowByTitle: window, ambiguity and unknown titles', () => {
  assert.equal(matchShowByTitle('Good Time Charlie', shows, { now: NOW }).show.id, 'good-time-charlie-off-broadway-2026');
  assert.equal(matchShowByTitle('Old Play', shows, { now: NOW }).reason, 'none'); // opened 2019, outside the window
  assert.equal(matchShowByTitle('Twin', shows, { now: NOW }).reason, 'ambiguous');
  assert.equal(matchShowByTitle('Nope', shows, { now: NOW }).reason, 'none');
  assert.equal(matchShowByTitle('', shows, { now: NOW }).reason, 'none');
});

test('planCollection fetches only unheld (show, url) pairs and says why it skipped the rest', () => {
  const url = 'https://www.talkinbroadway.com/page/ob/10_09_26.html';
  const entries = [
    { url, title: 'Good Time Charlie' },
    { url: 'https://www.talkinbroadway.com/page/ob/10_16_26.html', title: 'The Ask' },
    { url: 'https://www.talkinbroadway.com/page/ob/09_01_26.html', title: 'Untracked Show' },
    { url: 'https://www.talkinbroadway.com/page/ob/10_16_26.html', title: 'The Ask' },
  ];
  const held = new Set([heldKey('good-time-charlie-off-broadway-2026', url)]);
  const { toFetch, skipped } = planCollection(entries, shows, held, { now: NOW });
  assert.deepEqual(toFetch.map((t) => t.showId), ['the-ask-off-broadway-2026']);
  assert.deepEqual(skipped.map((s) => s.why), ['held', 'no-tracked-show']);
});

test('the same page held for one show is still fetched for a second show on a combined day page', () => {
  const url = 'https://www.talkinbroadway.com/page/ob/10_09_26.html';
  const held = new Set([heldKey('good-time-charlie-off-broadway-2026', url)]);
  const entries = [{ url, title: 'Good Time Charlie' }, { url, title: 'The Ask' }];
  const { toFetch } = planCollection(entries, shows, held, { now: NOW });
  assert.deepEqual(toFetch.map((t) => t.showId), ['the-ask-off-broadway-2026']);
});

test('matchShowByTitle never attaches a New York review to a West End run of the same title', () => {
  assert.equal(matchShowByTitle('London Only', shows, { now: NOW }).reason, 'none');
});

const oneReview = '<h2>Good Time Charlie</h2><P><B>Theatre Review by <A HREF="mailto:k@x">Kimberly Ramírez</A> - October 9, 2026</B><P>text';
const twoReviews = '<CENTER><B>Good Time Charlie</B></CENTER><P><B>Theatre Review by <A HREF="mailto:k@x">Kimberly Ramírez</A> - October 9, 2026</B><P>aaa'
  + '<CENTER><B>The Ask</B></CENTER><P><B>Theatre Review by <A HREF="mailto:m@x">Michael Dale</A> - October 9, 2026</B><P>bbb';

test('pickCriticForShow: one byline is the show\'s; several bylines need the heading to name the show', () => {
  assert.deepEqual(pickCriticForShow(oneReview, 'Good Time Charlie'), { critic: 'Kimberly Ramírez' });
  assert.deepEqual(pickCriticForShow(twoReviews, 'The Ask'), { critic: 'Michael Dale' });
  assert.deepEqual(pickCriticForShow(twoReviews, 'Good Time Charlie'), { critic: 'Kimberly Ramírez' });
  assert.deepEqual(pickCriticForShow(twoReviews, 'Some Other Show'), { skip: 'multi-review-page' });
  assert.deepEqual(pickCriticForShow('<p>no review here</p>', 'The Ask'), { skip: 'no-byline' });
});

test('pageTitleMatchesShow compares the quoted show title in the page title', () => {
  assert.equal(pageTitleMatchesShow('Talkin\' Broadway Off-Broadway - "Good Time Charlie" - 10/9/26', 'Good Time Charlie'), true);
  assert.equal(pageTitleMatchesShow('Talkin\' Broadway Off-Broadway - "The Ask" - 10/16/26', 'Good Time Charlie'), false);
  assert.equal(pageTitleMatchesShow('Talkin\' Broadway - Off Broadway Past Reviews', 'Good Time Charlie'), false);
});

test('titleFromLinkText drops the trailing review date and tolerates a cut-off one', () => {
  assert.equal(titleFromLinkText('Garry Starr: Classic Penguins - 9/9/26'), 'Garry Starr: Classic Penguins');
  assert.equal(titleFromLinkText("Thornton Wilder's The Emporium -"), "Thornton Wilder's The Emporium");
  assert.equal(titleFromLinkText('||: Girls :||: Chance :||: Music :|| - 5/28/26'), '||: Girls :||: Chance :||: Music :||');
  assert.equal(titleFromLinkText('Good Time Charlie'), 'Good Time Charlie');
  assert.equal(titleFromLinkText('Spider-Man - Turn Off the Dark - 2/8/26'), 'Spider-Man - Turn Off the Dark');
});

test('extractReviewLinks strips the date so the title can match a tracked show', () => {
  const links = extractReviewLinks([{ href: '/page/ob/10_09_26.html', text: 'Good Time Charlie - 10/9/26' }]);
  assert.equal(links[0].text, 'Good Time Charlie');
  const { toFetch } = planCollection(links.map((l) => ({ url: l.url, title: l.text })), shows, new Set(), { now: NOW });
  assert.deepEqual(toFetch.map((t) => t.showId), ['good-time-charlie-off-broadway-2026']);
});
