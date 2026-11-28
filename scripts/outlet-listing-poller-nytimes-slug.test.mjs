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

test('live feed fixture (headlines and links only): exactly the six theater reviews are kept', () => {
  const xml = fs.readFileSync(new URL('./fixtures/nyt-theater-rss-2026-11-27.xml', import.meta.url), 'utf8');
  const urls = keep(parseRssFeed(xml, new Date(0)));
  const slugs = urls.map((u) => u.split('/').pop().replace('.html', ''));
  assert.equal(urls.length, 6, slugs.join(', '));
  for (const k of ['seven-guitars-review', 'much-ado-about-nothing-review', 'the-fantasticks-review', 'eurotrash-young-vic-london-review', 'exhibitionist-good-thief-review', 'its-a-wonderful-life-blue-man-group-now-you-see-me-review']) {
    assert.ok(slugs.some((s) => s.startsWith(k)), `${k} kept`);
  }
});

test('nytimes drops a film review (/movies/) and a critic\'s-pick slug is kept', () => {
  assert.equal(keep([{ headline: 'A Film', url: 'https://www.nytimes.com/2026/10/22/movies/possible-love-review-the-lives-of-others.html' }]).length, 0);
  assert.equal(keep([{ headline: 'A Gem', url: 'https://www.nytimes.com/2026/11/03/theater/x-critics-pick-play.html' }]).length, 1);
});

test('class guard: an rss outlet whose reviews are slug-only must use titleOrUrlFilter, not a headline-only titleFilter', () => {
  const headlineOnlyOk = new Set(['artsfuse', 'lighting-and-sound-america']); // general-arts feeds, pageConfirmAll
  for (const [id, c] of Object.entries(poller.OUTLET_STRATEGY_CONFIG)) {
    if (c && c.strategy === 'rss' && c.titleFilter && !headlineOnlyOk.has(id)) assert.fail(`${id}: use titleOrUrlFilter`);
  }
  assert.ok(poller.OUTLET_STRATEGY_CONFIG.nytimes.titleOrUrlFilter && !poller.OUTLET_STRATEGY_CONFIG.nytimes.titleFilter);
});
