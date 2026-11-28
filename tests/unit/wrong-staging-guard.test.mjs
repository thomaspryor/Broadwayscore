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

// Ship-check 2026-11-18: critics' decks on real home-market reviews that an earlier draft refused.
test('decks naming a company, a film or a season keep the show\'s own review', () => {
  const shows = [
    IAWL,
    { id: 'blue', title: 'Here There Are Blueberries', category: 'off-broadway', venue: 'New York Theatre Workshop' },
    { id: 'down', title: 'Downstate', category: 'off-broadway', venue: 'Playwrights Horizons' },
    { id: 'bj', title: 'Beetlejuice', category: 'broadway', venue: 'Marquis Theatre' },
    { id: 'bj-tour', title: 'Beetlejuice', category: 'tour', venue: 'Fox Theatre' },
    { id: 'wanted', title: 'Wanted', category: 'off-broadway', venue: 'Pershing Square Signature Center', akaTitles: ['Gun & Powder'] },
    { id: 'cind', title: 'Cinderella', category: 'west-end', venue: 'London Palladium' },
    { id: 'imit', title: 'Imitation of Life', category: 'off-broadway', venue: 'Vineyard Theatre' },
  ];
  const lane = { fuzzy: true, mainTitle: true, allShowTitles: shows.map((s) => s.title) };
  setPressNameShows(shows);
  try {
    for (const [h, t] of [
      ['‘It’s a Wonderful Life’ review: the movie becomes a radio play', IAWL.title],
      ['Review: ‘It’s a Wonderful Life,’ the 1946 classic, as a radio play', IAWL.title],
      ['‘Downstate’ Review: Bruce Norris’s Play, From Steppenwolf Theatre Company, Arrives', 'Downstate'],
      ['Review: ‘Beetlejuice’ at the Fox Theatre is a ghoulish delight', 'Beetlejuice'],
      ['Wanted (Gun & Powder) review', 'Wanted'],
      ['Cinderella: panto season is back with a bang', 'Cinderella'],
      ['Imitation of Life: a remix of the Sirk film', 'Imitation of Life'],
    ]) assert.equal(rss.titleMatchesShow(h, t, lane), true, `refused: ${h}`);
    // A review URL naming the show and no other staging outweighs a company named in the headline.
    assert.equal(rss.itemNamesShow('Tectonic Theater Project\'s \'Here There Are Blueberries\' is a haunting act of witness',
      'https://www.timeout.com/newyork/theater/here-there-are-blueberries-review', 'Here There Are Blueberries', lane), true);
    // A headline naming the show's own house outweighs a casting-shaped slug.
    assert.equal(rss.itemNamesShow('It\'s a Wonderful Life: A Live Radio Play (Broadhurst Theatre)',
      'https://www.thewrap.com/its-a-wonderful-life-broadway-tituss-burgess-harry-hamlin/', IAWL.title, lane), true);
  } finally { setPressNameShows(null); }
});

// BRO-7793 (1): a Google News headline the strict matcher refuses raised no near-miss alarm (bare `continue`).
test('BRO-7793: Google News refusal of a known outlet review headline yields a google-news near-miss', async () => {
  const { googleNewsAdapter } = require(path.join(ROOT, 'scripts/lib/opening-night-lane/discovery.js'));
  const item = (title, src, n) => `<item><title>${title}</title><link>https://news.google.com/rss/articles/CBMi${n}</link><pubDate>Wed, 18 Nov 2026 12:00:00 GMT</pubDate><source url="${src}">x</source></item>`;
  const xml = `<rss><channel>${[
    item("Review: IT'S A WONDERFUL LIFE: A LIVE RADIO PLAY at Stages Houston - BroadwayWorld", 'https://www.broadwayworld.com', 'AAA'),
    item("Cast Set for IT'S A WONDERFUL LIFE: A LIVE RADIO PLAY at Stages Houston", 'https://www.broadwayworld.com', 'BBB'), // no review signal
    item("Review: IT'S A WONDERFUL LIFE: A LIVE RADIO PLAY at Stages Houston", 'https://www.unknown-blog.example', 'CCC'), // unknown outlet
  ].join('')}</channel></rss>`;
  setPressNameShows(FIXTURE);
  try {
    const adapter = googleNewsAdapter({ decodeImpl: async () => null, log: () => {} });
    const out = await adapter.discover({ show: IAWL, fetchText: async () => xml, night: null });
    const nm = out.filter((c) => c.nearMiss);
    assert.equal(nm.length, 1, JSON.stringify(out));
    assert.equal(nm[0].source, 'google-news');
    assert.match(nm[0].url, /^https:\/\/news\.google\.com\/rss\/articles\/CBMiAAA/);
    assert.equal(nm[0].outletId, 'broadwayworld');
    assert.ok(nm[0].nearMiss.length > 0);
  } finally { setPressNameShows(null); }
});

// BRO-7793 (2): home houses come from shows.json venues, the hand list covers resident companies, and "Sadler's Wells" matches.
test('BRO-7793: isHomeHouse reads venues from data, knows the missing companies, keeps the possessive', () => {
  const { isHomeHouse, billedTitleOtherProductionCue } = require(path.join(ROOT, 'scripts/lib/show-names.js'));
  setPressNameShows([
    { id: 'a', title: 'Some Play', category: 'off-broadway', venue: 'Zorblax Playhouse Annex' },
    { id: 'b', title: 'Other Play', category: 'regional', venue: 'Quuxville Opera House' },
  ]);
  try {
    for (const t of ['Theatre for a New Audience', 'Red Bull Theater', 'WP Theater', 'Ma-Yi Theater Company', 'National Black Theatre',
      'Jamie Lloyd Company', 'Royal Shakespeare Company', 'Nimax', 'Delfont Mackintosh', 'LW Theatres', 'Sheffield Theatres',
      "Sadler's Wells", 'Sadlers Wells', "Roundabout's", 'the Zorblax Playhouse Annex']) assert.equal(isHomeHouse(t), true, t);
    assert.equal(isHomeHouse('Quuxville Opera House'), false); // regional venues are other stagings
    assert.equal(isHomeHouse('Stages Houston'), false);
    // The cue exempts the home company, still fires on another staging.
    const title = IAWL.title;
    assert.equal(billedTitleOtherProductionCue(`${title}, Theatre for a New Audience`, title), null);
    assert.ok(billedTitleOtherProductionCue(`${title}, Stages Houston Theatre`, title));
  } finally { setPressNameShows(null); }
});

// BRO-7793 ship-check: data-built houses are whole names, never single venue words (regional theatres stay other stagings).
test('BRO-7793: venue words from shows.json never exempt regional stagings', () => {
  const { isHomeHouse, slugOtherStagingCue } = require(path.join(ROOT, 'scripts/lib/show-names.js'));
  // Home venues whose single words ("hope", "park", "national", "players", "playhouse") are common regional theatre words.
  setPressNameShows([IAWL,
    { id: 'h1', title: 'P1', category: 'off-broadway', venue: 'Hope Street Theatre' },
    { id: 'h2', title: 'P2', category: 'west-end', venue: 'National Theatre' },
    { id: 'h3', title: 'P3', category: 'off-broadway', venue: 'Park Avenue Armory' },
    { id: 'h4', title: 'P4', category: 'off-broadway', venue: 'Players Playhouse' }]);
  try {
    assert.equal(isHomeHouse('Hope Street Theatre'), true); // the whole name still counts
    for (const t of ['Pasadena Playhouse', 'Hope Repertory Theatre', 'Park Square Theatre', 'National Arts Centre', 'Ross Valley Players', 'Stages Houston'])
      assert.equal(isHomeHouse(t), false, t);
    assert.ok(slugOtherStagingCue('https://x.com/its-a-wonderful-life-a-live-radio-play-at-pasadena-playhouse', IAWL.title));
  } finally { setPressNameShows(null); }
});

test('BRO-7793: Google near-miss honours the night window and offers no wrapper ingest command', async () => {
  const { googleNewsAdapter } = require(path.join(ROOT, 'scripts/lib/opening-night-lane/discovery.js'));
  const { formatPressSignals } = require(path.join(ROOT, 'scripts/lib/opening-night-lane/near-miss.js'));
  const item = (d) => `<item><title>Review: IT'S A WONDERFUL LIFE: A LIVE RADIO PLAY at Stages Houston - BroadwayWorld</title><link>https://news.google.com/rss/articles/CBMi${d}</link><pubDate>${d === 'OLD' ? 'Mon, 02 Nov 2026 12:00:00 GMT' : 'Wed, 18 Nov 2026 22:00:00 GMT'}</pubDate><source url="https://www.broadwayworld.com">x</source></item>`;
  setPressNameShows(FIXTURE);
  try {
    const adapter = googleNewsAdapter({ decodeImpl: async () => null, log: () => {} });
    const night = '2026-11-18';
    const out = await adapter.discover({ show: IAWL, fetchText: async () => `<rss><channel>${item('OLD')}${item('NEW')}</channel></rss>`, night, timeZone: 'America/New_York' });
    const nm = out.filter((c) => c.nearMiss);
    assert.equal(nm.length, 1, JSON.stringify(nm));
    assert.match(nm[0].url, /CBMiNEW/);
    const text = formatPressSignals(IAWL, night, { nearMisses: [{ ...nm[0], adapter: 'google-news', signals: nm[0].nearMiss }] }).description;
    assert.doesNotMatch(text, /add --show|ingest-urls/);
    assert.match(text, /NEAR-MISS/);
  } finally { setPressNameShows(null); }
});
