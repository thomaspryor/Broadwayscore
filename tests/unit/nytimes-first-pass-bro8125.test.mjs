// BRO-8125: first pass kept missing nytimes reviews. Two proven causes (CLAUDE.md rule 21 class guard):
//  1. The NYT Theater feed was pinned to market 'broadway', so checkRSSFeeds skipped it for West End shows
//     (The Lives of Others, 2026-10-29).
//  2. "Clifford Odets' Waiting for Lefty" never matched NYT's "'Waiting for Lefty' Review" (author-possessive
//     prefix not printed); the outlet poller handled it (BRO-7402) but rss-discovery did not.
// Tests require() the real functions (rule 15).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const rss = require('../../scripts/lib/rss-discovery.js');
const names = require('../../scripts/lib/show-names.js');

test('NYT Theater feed is read for every market a show can be in', () => {
  const nyt = rss.ALL_FEEDS.find((f) => f.outletId === 'nytimes');
  assert.ok(nyt, 'nytimes feed present');
  for (const market of ['broadway', 'west-end', 'regional']) {
    assert.equal(rss.feedAppliesToMarket(nyt, market), true, `nytimes feed skipped for ${market}`);
  }
});

test('feedAppliesToMarket still restricts market-pinned feeds', () => {
  const we = rss.ALL_FEEDS.find((f) => f.outletId === 'whatsonstage');
  assert.equal(rss.feedAppliesToMarket(we, 'west-end'), true);
  assert.equal(rss.feedAppliesToMarket(we, 'broadway'), false);
});

test('Lives of Others: NYT headline and slug (no review word) is accepted inside the review-free window', () => {
  names.setPressNameShows([]);
  const item = {
    title: 'Keira Knightley Shines in ‘The Lives of Others’',
    link: 'https://www.nytimes.com/2026/11/02/theater/lives-of-others-kiera-knightley-robert-icke.html',
    pubDate: new Date('2026-10-30T12:00:00Z'),
  };
  assert.equal(rss.openingWindowFeedAccepts(item, 'The Lives of Others', '2026-10-29'), true);
});

test('Waiting for Lefty: author-possessive billing matches the title NYT prints', () => {
  names.setPressNameShows([{ title: 'Clifford Odets’ Waiting for Lefty', category: 'off-broadway',
    creativeTeam: [{ name: 'Clifford Odets' }] }]);
  const title = 'Clifford Odets’ Waiting for Lefty';
  const item = {
    title: '‘Waiting for Lefty’ Review: A Labor Play Rouses Again',
    link: 'https://www.nytimes.com/2026/11/03/theater/waiting-for-lefty-review-odets-pasquale.html',
    pubDate: new Date('2026-11-03T15:00:00Z'),
  };
  assert.equal(rss.titleMatchesShow(item.title, title, {}), true);
  assert.equal(rss.openingWindowFeedAccepts(item, title, '2026-11-03'), true);
  names.setPressNameShows(null);
});

test('author-possessive form needs the owner on the show team and 3+ words left', () => {
  // Owner not on the team: a character possessive ("Joe Turner's Come and Gone") gets no extra name.
  names.setPressNameShows([{ title: 'Joe Turner’s Come and Gone', category: 'broadway', creativeTeam: [{ name: 'August Wilson' }] }]);
  assert.equal(rss.titleMatchesShow('Review: Come and Gone at a fringe venue', 'Joe Turner’s Come and Gone', {}), false);
  assert.deepEqual(names.showNames({ title: 'Joe Turner’s Come and Gone' }).map((n) => n.name), ['Joe Turner’s Come and Gone']);
  // Fewer than 3 words left: no form.
  assert.equal(names.authorPossessiveRest('Neil Simon’s Fools'), null);
  assert.equal(names.authorPossessiveRest('Clifford Odets’ Waiting for Lefty').rest, 'Waiting for Lefty');
  names.setPressNameShows(null);
});
