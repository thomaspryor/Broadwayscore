// BRO-7785: a licensed billed title is staged everywhere. Real Google News headlines and URLs for other stagings of
// "It's A Wonderful Life: A Live Radio Play" (Stages Houston, Oil Lamp, Citadel) and Vulture's Oct 1 casting story
// must be refused on every path (lane, old poller, Google News, review-guards urlLooksLikeReview), while the Broadway
// production's own reviews still match. Red with the fix reverted: every "refused" case below was admitted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const { setPressNameShows } = require(path.join(ROOT, 'scripts/lib/show-names.js'));
const rss = require(path.join(ROOT, 'scripts/lib/rss-discovery.js'));
const { headlineNamesShow } = require(path.join(ROOT, 'scripts/lib/google-news-rss.js'));
const { urlLooksLikeReview } = require(path.join(ROOT, 'scripts/lib/review-guards.js'));

const IAWL = {
  id: 'iawl', title: 'It’s A Wonderful Life: A Live Radio Play', category: 'broadway', venue: 'Broadhurst Theatre',
  akaTitles: ["It's a Wonderful Life"], cast: [{ name: 'Lisa Rinna' }, { name: 'Megan Hilty' }, { name: 'Andrew Rannells' }],
};
const FIXTURE = [
  IAWL,
  { id: 'hay', title: 'Hay Fever', category: 'west-end', venue: 'Theatre Royal Haymarket', cast: [{ name: 'Richard E. Grant' }] },
  { id: 'carol-regional', title: 'A Christmas Carol', category: 'regional', venue: 'Goodman Theatre' },
];
const ALL = FIXTURE.map((s) => s.title);
const LANE = { fuzzy: true, mainTitle: true, allShowTitles: ALL };

// Real items from the 2026-11-18 Google News feed for the title (headline, link).
const OTHER_STAGINGS = [
  ["Review: IT'S A WONDERFUL LIFE: A LIVE RADIO PLAY at Stages Houston - BroadwayWorld",
    'https://www.broadwayworld.com/houston/article/Review-ITS-A-WONDERFUL-LIFE-A-LIVE-RADIO-PLAY-at-Stages-Houston-20261118'],
  ['It’s a Wonderful Life Review- Oil Lamp Theater’s live radio play - Splash Magazines Worldwide',
    'https://www.splashmagazines.com/its-a-wonderful-life-review-oil-lamp-theaters-live-radio-play/'],
  ["Cast Set for IT'S A WONDERFUL LIFE: A LIVE RADIO PLAY at Oil Lamp Theater - BroadwayWorld", ''],
  ['“It’s A Wonderful Life: A Live Radio Program at Oil Lamp Theatre” - AROUND THE TOWN CHICAGO', ''],
  ['“It’s A Wonderful Life” the Live Radio Show ( Citadel) - AROUND THE TOWN CHICAGO', ''],
  ["Review: Try a live version of 'It's a Wonderful Life' at Stages for a holiday alternative - Houston Chronicle", ''],
];
const VULTURE = 'https://www.vulture.com/article/its-a-wonderful-life-broadway-lisa-rinna.html';
const OWN = [
  ["Review: It's a Wonderful Life", 'https://www.nytimes.com/2026/11/19/theater/its-a-wonderful-life-review.html'],
  ["Review: It's A Wonderful Life: A Live Radio Play on Broadway", ''],
  ["Lisa Rinna's Broadway debut in It's a Wonderful Life: A Live Radio Play", ''],
  ["Review: It's A Wonderful Life: A Live Radio Play - The New York Times", ''],
  ["'It's a Wonderful Life' Review: Megan Hilty and Lisa Rinna at the Broadhurst - Variety", ''],
];
const NIGHT = new Date('2026-11-18T00:00:00Z');
const feedItem = (title, link) => ({ title, link, pubDate: new Date('2026-11-19T03:00:00Z') });

function withFixture(fn) {
  setPressNameShows(FIXTURE);
  try { fn(); } finally { setPressNameShows(null); }
}

test('other stagings of the billed title are refused on lane, poller and Google News', () => withFixture(() => {
  for (const [title, link] of OTHER_STAGINGS) {
    assert.equal(rss.itemNamesShow(title, link, IAWL.title, LANE), false, `lane admitted: ${title}`);
    assert.equal(rss.titleMatchesShow(title, IAWL.title, LANE), false, `lane title admitted: ${title}`);
    assert.equal(rss.openingWindowFeedAccepts(feedItem(title, link), IAWL.title, NIGHT), false, `poller admitted: ${title}`);
    assert.equal(!!headlineNamesShow(title, IAWL), false, `google admitted: ${title}`);
  }
}));

test('other-staging and casting URLs are refused by urlLooksLikeReview (site search, gather)', () => withFixture(() => {
  for (const [, link] of OTHER_STAGINGS.filter(([, l]) => l)) {
    assert.equal(urlLooksLikeReview(link, IAWL.title), false, `url admitted: ${link}`);
  }
  assert.equal(urlLooksLikeReview(VULTURE, IAWL.title), false, 'Vulture casting story admitted');
  assert.equal(rss.itemNamesShow("It's a Wonderful Life Broadway cast", VULTURE, IAWL.title, LANE), false, 'lane admitted Vulture');
}));

test('the Broadway production still matches', () => withFixture(() => {
  for (const [title, link] of OWN) {
    assert.equal(rss.itemNamesShow(title, link, IAWL.title, LANE), true, `lane missed: ${title}`);
    assert.equal(rss.openingWindowFeedAccepts(feedItem(title, link), IAWL.title, NIGHT), true, `poller missed: ${title}`);
    assert.equal(!!headlineNamesShow(title, IAWL), true, `google missed: ${title}`);
  }
  assert.equal(urlLooksLikeReview(OWN[0][1], IAWL.title), true, 'NYT review URL refused');
}));

test('critics\' decks and regional-only titles are not mistaken for another staging', () => withFixture(() => {
  // A colon deck after a billed title is the critic's, not a subtitle (Hay Fever, West End).
  assert.equal(rss.titleMatchesShow('Hay Fever: Richard E. Grant hams it up gloriously - The Guardian', 'Hay Fever', LANE), true);
  assert.equal(rss.titleMatchesShow('Hay Fever review – a frothy delight (Published 2025) - The New York Times', 'Hay Fever', LANE), true);
  // A title billed by a regional entry is gathered for that city, so its own venue is never "another staging".
  assert.equal(rss.titleMatchesShow('Review: A Christmas Carol at Goodman Theatre', 'A Christmas Carol', LANE), true);
  assert.equal(urlLooksLikeReview('https://chicagoreader.com/a-christmas-carol-at-goodman-theatre-review/', 'A Christmas Carol'), true);
}));

test('WRONG_STAGING_GUARD_OFF=1 restores the old behaviour in one switch', () => withFixture(() => {
  const [title, link] = OTHER_STAGINGS[0];
  process.env.WRONG_STAGING_GUARD_OFF = '1';
  try {
    assert.equal(rss.itemNamesShow(title, link, IAWL.title, LANE), true);
    assert.equal(urlLooksLikeReview(VULTURE, IAWL.title), true);
  } finally { delete process.env.WRONG_STAGING_GUARD_OFF; }
  assert.equal(rss.itemNamesShow(title, link, IAWL.title, LANE), false);
}));
