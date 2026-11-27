/**
 * BRO-8125: the first pass kept missing nytimes reviews (Waiting for Lefty, Ms. Blakk for President),
 * found days later by audit-aggregator-gap. NYT review headlines rarely contain "Review"; the word is in
 * the URL slug. The nytimes RSS filter looked at the headline only. Fixture: live Theater feed 2026-11-27.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const poller = require('./outlet-listing-poller.js');
const { parseRssFeed } = require('./lib/outlet-listing-helpers');
const cfg = poller.OUTLET_STRATEGY_CONFIG.nytimes;
const keep = (items) => poller.applyRssFilters(items, cfg).map((i) => i.url);

test('nytimes keeps reviews whose headline has no "Review" but whose slug does (the missed shows)', () => {
  const missed = [
    { headline: 'A Fierce Revival of Odets’s Labor Drama', url: 'https://www.nytimes.com/2026/11/03/theater/waiting-for-lefty-review-odets-pasquale.html' },
    { headline: 'A Drag Queen Runs for President, Again', url: 'https://www.nytimes.com/2026/11/10/theater/ms-blakk-for-president-review-mccraney-glick-blankson-wood.html' },
  ];
  assert.deepEqual(keep(missed), missed.map((m) => m.url));
});

test('nytimes still drops features and news with no review word anywhere', () => {
  const news = [
    { headline: 'The 75-Year Secret Behind ‘The Mousetrap’', url: 'https://www.nytimes.com/2026/11/24/theater/the-mousetrap-75th-anniversary.html' },
    { headline: 'Griselda Gambaro Has Died', url: 'https://www.nytimes.com/2026/11/18/theater/griselda-gambaro-dead.html' },
  ];
  assert.deepEqual(keep(news), []);
});

test('live feed fixture: slug-review items reach the first pass, news does not', () => {
  const xml = fs.readFileSync(new URL('./fixtures/nyt-theater-rss-2026-11-27.xml', import.meta.url), 'utf8');
  const urls = keep(parseRssFeed(xml, new Date(0)));
  assert.ok(urls.some((u) => /much-ado-about-nothing-review/.test(u)), 'Much Ado review (no "Review" in headline) kept');
  assert.ok(urls.some((u) => /seven-guitars-review/.test(u)), 'Seven Guitars review kept');
  assert.ok(!urls.some((u) => /mousetrap-75th|griselda-gambaro-dead/.test(u)), 'news dropped');
});

test('class guard: no rss outlet filters on the headline alone (slug-only review words are missed)', () => {
  for (const [id, c] of Object.entries(poller.OUTLET_STRATEGY_CONFIG)) {
    assert.ok(!(c && c.strategy === 'rss' && c.titleFilter), `${id}: use titleOrUrlFilter so a slug-only "review" is not dropped`);
  }
});

test("nytimes keeps a critic's-pick slug and drops the film/arts items in the live fixture", () => {
  assert.deepEqual(keep([{ headline: 'A Gem', url: 'https://www.nytimes.com/2026/11/03/theater/x-critics-pick-play.html' }]).length, 1);
  const xml = fs.readFileSync(new URL('./fixtures/nyt-theater-rss-2026-11-27.xml', import.meta.url), 'utf8');
  const urls = keep(parseRssFeed(xml, new Date(0)));
  assert.ok(!urls.some((u) => /\/(movies|arts)\//.test(u)), 'movies/arts items dropped');
});
