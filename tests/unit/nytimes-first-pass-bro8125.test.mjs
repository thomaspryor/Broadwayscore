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

// Window rule only (it ignores market); the market fix itself is guarded by the first test.
test('Lives of Others: NYT headline and slug (no review word) is accepted four days after opening', () => {
  names.setPressNameShows([]);
  const item = {
    title: 'Keira Knightley Shines in ‘The Lives of Others’',
    link: 'https://www.nytimes.com/2026/11/02/theater/lives-of-others-kiera-knightley-robert-icke.html',
    pubDate: new Date('2026-11-02T12:00:00Z'),
  };
  assert.equal(rss.openingWindowFeedAccepts(item, 'The Lives of Others', '2026-10-29', 'nytimes'), true);
});

test('late NYT feed rejects show news and requires headline identity', () => {
  const base = { link: 'https://example.com/article', pubDate: new Date('2026-11-02T12:00:00Z') };
  for (const title of ['The Lives of Others Extends Its Run', 'The Lives of Others Is Closing', 'The Lives of Others Will Transfer']) {
    assert.equal(rss.openingWindowFeedAccepts({ ...base, title }, 'The Lives of Others', '2026-10-29', 'nytimes'), false, title);
    assert.equal(rss.openingWindowFeedAccepts({ ...base, title, link: 'https://example.com/review' }, 'The Lives of Others', '2026-10-29', 'nytimes'), false, title);
  }
  assert.equal(rss.openingWindowFeedAccepts({ ...base, title: 'A Theater Feature', link: 'https://example.com/lives-of-others' }, 'The Lives of Others', '2026-10-29', 'nytimes'), false);
  assert.equal(rss.openingWindowFeedAccepts({ ...base, title: 'Keira Knightley Shines in ‘The Lives of Others’' }, 'The Lives of Others', '2026-10-29', 'variety'), false);
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

test('author-possessive form: owner must be one creativeTeam name, and the rest may not be another show\'s billed title', () => {
  // Owner only in the cast, not the creative team: no form.
  names.setPressNameShows([{ title: 'Dr. Seuss’ How the Grinch Stole Christmas!', category: 'broadway', cast: [{ name: 'Dr Seuss' }] }]);
  assert.equal(names.showNames({ title: 'Dr. Seuss’ How the Grinch Stole Christmas!' }).length, 1);
  assert.equal(rss.titleMatchesShow('Jim Carrey Returns for How the Grinch Stole Christmas! Sequel', 'Dr. Seuss’ How the Grinch Stole Christmas!', {}), false);
  // The rest is another show's billed title: no form.
  names.setPressNameShows([
    { title: 'Clifford Odets’ Waiting for Lefty', category: 'off-broadway', creativeTeam: [{ name: 'Clifford Odets' }] },
    { title: 'Waiting for Lefty', category: 'regional' },
  ]);
  assert.equal(names.showNames({ title: 'Clifford Odets’ Waiting for Lefty' }).length, 1);
  names.setPressNameShows(null);
});

test('a closed show does not vouch for or block an open show billed alike', () => {
  names.setPressNameShows([
    { title: 'Dr. Seuss’ How the Grinch Stole Christmas!', status: 'closed', category: 'broadway', creativeTeam: [{ name: 'Dr. Seuss' }] },
    { title: 'Dr. Seuss’ How the Grinch Stole Christmas!', status: 'open', category: 'tour' },
  ]);
  assert.equal(names.showNames({ title: 'Dr. Seuss’ How the Grinch Stole Christmas!' }).length, 1);
  names.setPressNameShows(null);
});
