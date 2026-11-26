// BRO-7402: Front Row Center reviewed Wuthering Heights (Off-Broadway, ran 2026-11-19 to 11-22) on 2026-11-24.
// Both first-pass pollers missed it and the aggregator-gap sweep found it on 11-26:
//  - the 3-hourly opening-window poller only matches shows 0-3 days past opening (it was day 5);
//  - the daily poller matched feed items only against open/previews shows, and the show had closed.
// Reverting either fix (front-row-center in LATE_PUBLISHER_WINDOW_DAYS, or the daily feed pool's
// recently-closed shows / the poller wiring) fails a test here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ow = require('./outlet-opening-window.js');
const { findMatchingShows } = require('./outlet-listing-helpers.js');
const here = path.dirname(fileURLToPath(import.meta.url));

// The real shows.json record (fields the pollers read).
const wuthering = {
  id: 'wuthering-heights-off-broadway-2026', title: 'Wuthering Heights', status: 'closed',
  category: 'off-broadway', market: 'broadway', openingDate: '2026-11-19', previewsStartDate: '2026-11-19',
  closingDate: '2026-11-22', venue: 'The Sheen Center', creativeTeam: [],
};
const oldWuthering = { id: 'wuthering-heights-west-end-2022', title: 'Wuthering Heights', status: 'closed', category: 'west-end', openingDate: '2022-02-09', closingDate: '2022-03-19' };
const running = { id: 'some-open-show', title: 'Some Open Show', status: 'open', category: 'off-broadway', openingDate: '2026-10-01' };
const item = { headline: 'Wuthering Heights', url: 'https://thefrontrowcenter.com/2026/11/wuthering-heights-2', publishDate: '2026-11-24' };

test('window poller: front-row-center matches a show 5 days past opening (late-publisher window)', () => {
  const at = Date.parse('2026-11-24T12:00:00Z');
  const win = ow.selectWindowShows([wuthering], at);
  assert.equal(win.length, 0, 'the 0-3 day window alone misses it (the original gap)');
  const late = ow.selectLateWindowShows([wuthering], at);
  assert.deepEqual(ow.lateOutletsToPoll(late, { 'front-row-center': { strategy: 'rss' } }, {}), ['front-row-center']);
  assert.deepEqual(ow.poolForOutlet('front-row-center', win, late, at).map((s) => s.id), [wuthering.id]);
});

test('daily poller: a show that closed before its review posted stays in the feed pool and matches', () => {
  const cutoff = new Date(Date.parse('2026-11-25T20:16:00Z') - 7 * 86400000); // the 11-25 daily run, 7-day lookback
  const all = [running, wuthering, oldWuthering];
  const active = all.filter((s) => s.status === 'open' || s.status === 'previews');
  const pool = ow.dailyFeedPool(active, all, cutoff, {});
  assert.deepEqual(pool.map((s) => s.id).sort(), [running.id, wuthering.id].sort(), 'old 2022 production stays out');
  const matched = findMatchingShows(item.headline, new URL(item.url).pathname, pool, '', { publishDate: item.publishDate })
    .filter((s) => ow.closedShowMatchOk(s, { liveShows: active, publishDate: item.publishDate }));
  assert.deepEqual(matched.map((s) => s.id), [wuthering.id]);
  // Before the fix the pool was `active` alone: nothing matched.
  assert.deepEqual(findMatchingShows(item.headline, new URL(item.url).pathname, active, '', { publishDate: item.publishDate }), []);
});

test('market filter applies to recently closed shows', () => {
  const cutoff = new Date('2026-11-18T00:00:00Z');
  assert.deepEqual(ow.selectRecentlyClosedShows([wuthering], cutoff, { market: 'west-end' }), []);
  assert.deepEqual(ow.selectRecentlyClosedShows([wuthering], cutoff, { market: 'off-broadway' }).map((s) => s.id), [wuthering.id]);
});

test('a recently closed show yields to a running show of the same title (transfer/revival)', () => {
  const transfer = { id: 'wuthering-heights-broadway-2026', title: 'Wuthering Heights', status: 'previews', category: 'broadway', openingDate: '2026-12-01' };
  assert.equal(ow.closedShowMatchOk(wuthering, { liveShows: [transfer], publishDate: '2026-11-24' }), false);
  assert.equal(ow.closedShowMatchOk(transfer, { liveShows: [transfer], publishDate: '2026-11-24' }), true);
  assert.equal(ow.closedShowMatchOk(wuthering, { liveShows: [running], publishDate: '2026-11-24' }), true);
  assert.equal(ow.closedShowMatchOk(wuthering, { liveShows: [], publishDate: '2026-10-01' }), false, 'item predates the run');
});

test('outlet-listing-poller wires the daily feed pool and the closed-show check', () => {
  const src = fs.readFileSync(path.join(here, '..', 'outlet-listing-poller.js'), 'utf8');
  assert.match(src, /const feedPool = win \? activeShows : ow\.dailyFeedPool\(/);
  assert.match(src, /win \? ow\.poolForOutlet\(outletId, activeShows, lateShows\) : feedPool\)/);
  assert.match(src, /const censusOk = \(show\) => closedOk\(show\) &&/);
});
