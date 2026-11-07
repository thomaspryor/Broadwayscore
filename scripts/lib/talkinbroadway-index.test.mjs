import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  titleFromLinkText, dateFromLinkText, holdsReview, bylineDate, resolveAgainst, reviewDateFitsShow, normalizeTbUrl, isReviewHref, normalizeTitle, extractReviewLinks, titleFromPageTitle,
  matchShowByTitle, heldKey, planCollection, pickCriticForShow, pageTitleMatchesShow,
} = require('./talkinbroadway-index.js');

const NOW = new Date('2026-10-19T12:00:00Z');
const shows = [
  { id: 'good-time-charlie-off-broadway-2026', title: 'Good Time Charlie', openingDate: '2026-10-09', market: 'broadway', category: 'off-broadway' },
  { id: 'the-ask-off-broadway-2026', title: 'The Ask', openingDate: '2026-10-15', market: 'broadway', category: 'off-broadway' },
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
  assert.deepEqual(extractReviewLinks(anchors), [{ url: 'https://www.talkinbroadway.com/page/ob/10_09_26.html', text: 'Good Time Charlie', date: null }]);
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

test('planCollection fetches only unheld shows and says why it skipped the rest', () => {
  const entries = [
    { url: 'https://www.talkinbroadway.com/page/ob/10_09_26.html', title: 'Good Time Charlie', date: '2026-10-09' },
    { url: 'https://www.talkinbroadway.com/page/ob/10_16_26.html', title: 'The Ask', date: '2026-10-16' },
    { url: 'https://www.talkinbroadway.com/page/ob/09_01_26.html', title: 'Untracked Show', date: '2026-09-01' },
    { url: 'https://www.talkinbroadway.com/page/ob/10_16_26.html', title: 'The Ask', date: '2026-10-16' },
  ];
  const held = new Set([heldKey('good-time-charlie-off-broadway-2026')]);
  const { toFetch, skipped } = planCollection(entries, shows, held, { now: NOW });
  assert.deepEqual(toFetch.map((t) => t.showId), ['the-ask-off-broadway-2026']);
  assert.deepEqual(skipped.map((s) => s.why), ['held', 'no-tracked-show', 'second-review-same-show']);
});

test('a hand-added review under a different URL still counts as held (Very Blue Light, 09_25_26b)', () => {
  const entries = [{ url: 'https://www.talkinbroadway.com/page/ob/10_09_26b.html', title: 'Good Time Charlie', date: '2026-10-09' }];
  const held = new Set([heldKey('good-time-charlie-off-broadway-2026')]);
  assert.deepEqual(planCollection(entries, shows, held, { now: NOW }).toFetch, []);
});

test('an earlier same-title run or a review far from the opening is not attached (Ectoplasm 2022, Going Bacharach January)', () => {
  const entries = [
    { url: 'https://www.talkinbroadway.com/page/ob/01_16_22.html', title: 'Good Time Charlie', date: '2022-01-16' },
    { url: 'https://www.talkinbroadway.com/page/ob/01_12_26.html', title: 'Good Time Charlie', date: '2026-01-12' },
  ];
  const { toFetch, skipped } = planCollection(entries, shows, new Set(), { now: NOW });
  assert.deepEqual(toFetch, []);
  assert.deepEqual(skipped.map((s) => s.why), ['date-outside-run', 'date-outside-run']);
});

test('reviewDateFitsShow: ten days before to sixty days after the opening', () => {
  const show = { openingDate: '2026-10-09' };
  assert.equal(reviewDateFitsShow('2026-09-29', show), true);
  assert.equal(reviewDateFitsShow('2026-09-28', show), false);
  assert.equal(reviewDateFitsShow('2026-12-08', show), true);
  assert.equal(reviewDateFitsShow('2026-12-09', show), false);
  assert.equal(reviewDateFitsShow(null, show), false);
});

test('dateFromLinkText reads M/D/YY and rejects a cut-off or impossible date', () => {
  assert.equal(dateFromLinkText('Isla - 8/18/26'), '2026-08-18');
  assert.equal(dateFromLinkText("Thornton Wilder's The Emporium -"), null);
  assert.equal(dateFromLinkText('Thing - 13/40/26'), null);
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
  assert.equal(links[0].date, '2026-10-09');
  const { toFetch } = planCollection(links.map((l) => ({ url: l.url, title: l.text, date: l.date })), shows, new Set(), { now: NOW });
  assert.deepEqual(toFetch.map((t) => t.showId), ['good-time-charlie-off-broadway-2026']);
});

test('Broadway list links have no date: they are queued for a check against the page byline date', () => {
  const entries = [{ url: 'https://www.talkinbroadway.com/page/world/GoodTimeCharlie.html', title: 'Good Time Charlie', date: null }];
  const { toFetch } = planCollection(entries, shows, new Set(), { now: NOW });
  assert.equal(toFetch.length, 1);
  assert.equal(toFetch[0].verifyPageDate, true);
  assert.equal(toFetch[0].openingDate, '2026-10-09');
});

test('bylineDate reads the page byline, so an older run of the same title is caught after the fetch', () => {
  const html = '<P><B>Theatre Review by <A HREF="mailto:x">Howard Miller</A> - October 19, 2026</B>';
  assert.equal(bylineDate(html), '2026-10-19');
  assert.equal(bylineDate('<B>Theatre Review by Matthew Murray - May 3, 2022</B>'), '2022-05-03');
  assert.equal(bylineDate('<p>no byline</p>'), null);
  assert.equal(reviewDateFitsShow(bylineDate('<B>Theatre Review by Matthew Murray - May 3, 2022</B>'), { openingDate: '2026-10-09' }), false);
});

test('resolveAgainst makes the Broadway list hrefs absolute under /page/world/', () => {
  const base = 'https://www.talkinbroadway.com/page/world/past.html';
  assert.equal(resolveAgainst(base, 'JoeTurnersComeandGone.html'), 'https://www.talkinbroadway.com/page/world/JoeTurnersComeandGone.html');
  assert.equal(resolveAgainst(base, '/page/ob/10_09_26.html'), 'https://www.talkinbroadway.com/page/ob/10_09_26.html');
  const links = extractReviewLinks([
    { href: resolveAgainst(base, 'Bug.html'), text: 'Bug' },
    { href: resolveAgainst(base, 'past.html'), text: 'Past reviews' },
    { href: resolveAgainst(base, '/'), text: 'Home page' },
  ]);
  assert.deepEqual(links.map((l) => l.url), ['https://www.talkinbroadway.com/page/world/Bug.html']);
});

test('a Broadway-list link never attaches to an Off Broadway show of the same title, and vice versa', () => {
  const both = [
    { id: 'macbeth-off-broadway-2026', title: 'Macbeth', openingDate: '2026-10-05', market: 'broadway', category: 'off-broadway' },
  ];
  const fromWorld = [{ url: 'https://www.talkinbroadway.com/page/world/Macbeth22.html', title: 'Macbeth', date: null, section: 'world', rank: 9 }];
  assert.equal(planCollection(fromWorld, both, new Set(), { now: NOW }).skipped[0].why, 'wrong-section');
  const fromOb = [{ url: 'https://www.talkinbroadway.com/page/ob/10_05_26.html', title: 'Macbeth', date: '2026-10-05', section: 'ob', rank: 3 }];
  assert.equal(planCollection(fromOb, both, new Set(), { now: NOW }).toFetch.length, 1);
});

test('an undated link far down a newest-first list is skipped without a page load', () => {
  const entry = (rank) => [{ url: 'https://www.talkinbroadway.com/page/ob/Thing.html', title: 'Good Time Charlie', date: null, section: 'ob', rank }];
  assert.equal(planCollection(entry(5), shows, new Set(), { now: NOW }).toFetch.length, 1);
  assert.equal(planCollection(entry(500), shows, new Set(), { now: NOW }).skipped[0].why, 'undated-not-recent');
});

test('matchShowByTitle covers a show that opened up to 400 days ago (Every Brilliant Thing at 223 days, All Out at 313)', () => {
  const april = [{ id: 'joe-turners-come-and-gone-2026', title: "Joe Turner's Come and Gone", openingDate: '2026-04-25', market: 'broadway', category: 'broadway' }];
  assert.equal(matchShowByTitle("Joe Turner's Come and Gone", april, { now: NOW }).reason, 'match');
  assert.equal(matchShowByTitle("Joe Turner's Come and Gone", april, { now: new Date('2027-10-01T12:00:00Z') }).reason, 'none');
});

test('holdsReview: a flagged or invalid file still counts, an empty stub or a forum-thread husk does not', () => {
  const page = 'https://www.talkinbroadway.com/page/ob/10_09_26.html';
  assert.equal(holdsReview({ url: page, contentTier: 'complete' }), true);
  assert.equal(holdsReview({ url: page, contentTier: 'invalid', wrongProduction: true }), true);
  assert.equal(holdsReview({ url: page, contentTier: 'stub' }), false);
  assert.equal(holdsReview({ url: 'https://www.talkinbroadway.com/allthatchat_new/d.php?id=2654250', contentTier: 'excerpt' }), false);
  assert.equal(holdsReview({ contentTier: 'complete' }), false);
  assert.equal(holdsReview(null), false);
});
