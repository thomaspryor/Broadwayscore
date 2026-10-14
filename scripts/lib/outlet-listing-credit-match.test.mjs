// BRO-5326: the outlet-first poller skipped one-word titles under 5 letters, so
// Theater Pizzazz's and Off Off Online's Fish reviews (both in their RSS feeds the
// day after opening) were never filed. require()s the real matcher (CLAUDE.md §15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { findMatchingShows, namesShowCredit } = require('./outlet-listing-helpers.js');

// Names and title copied from the real fish-off-broadway-2026 record.
const fish = {
  id: 'fish-off-broadway-2026', title: 'Fish', status: 'open',
  creativeTeam: [{ name: 'Melis Aker', role: 'Playwright' }, { name: 'Tatiana Pandiani', role: 'Director' }],
  cast: [{ name: 'Yasmin Lara Ranz-Lind', role: 'Karya' }, { name: 'Sara Haider', role: 'Isha' }],
};
const six = { id: 'six-broadway', title: 'SIX', status: 'open', creativeTeam: [{ name: 'Toby Marlow', role: 'Book' }], cast: [] };
const noCredits = { id: 'rope-ob-2026', title: 'Rope', status: 'open' };
const ids = (m) => m.map((s) => s.id);

test('the real Fish headline and slug now match when the playwright is named', () => {
  assert.deepEqual(ids(findMatchingShows('It’s Sink or Swim in Melis Aker’s “Fish”', 'its-sink-or-swim-in-melis-akers-fish', [fish])), ['fish-off-broadway-2026']);
});

test('a director or cast name is enough credit context', () => {
  assert.equal(findMatchingShows('Fish review: Tatiana Pandiani stages a teen thriller', 'fish-review', [fish]).length, 1);
  assert.equal(findMatchingShows('Fish: Sara Haider stands out', 'fish', [fish]).length, 1);
});

test('a generic article with the word but no credit still does not match', () => {
  assert.equal(findMatchingShows('The best fish and chips in the West End', 'best-fish-and-chips', [fish]).length, 0);
  assert.equal(findMatchingShows('Big Fish returns to the stage', 'big-fish-returns', [fish]).length, 0);
});

test('a first or last name alone is not credit', () => {
  assert.equal(findMatchingShows('Fish stories from Melis', 'fish-stories', [fish]).length, 0);
  assert.equal(namesShowCredit(' aker ', fish), false);
});

test('common-word titles keep their old skip even with credit (per-show SERP handles them)', () => {
  assert.equal(findMatchingShows('Six actors on Toby Marlow’s SIX', 'six-actors-toby-marlow-six', [six]).length, 0);
  assert.equal(findMatchingShows('Six things to know about Lucy Moss’s new show', 'six-things-lucy-moss', [six]).length, 0);
});

// Reproduced during review of the first version, which matched all four of these.
test('other productions and biopics do not borrow a show’s credits', () => {
  const chicago = { id: 'chicago-1996', title: 'Chicago', status: 'open', creativeTeam: [{ name: 'John Kander', role: 'Music' }, { name: 'Fred Ebb', role: 'Lyrics' }, { name: 'Bob Fosse', role: 'Book' }], cast: [] };
  const oliver = { id: 'oliver-west-end-2024', title: 'Oliver!', status: 'open', creativeTeam: [{ name: 'Lionel Bart', role: 'Book, Music & Lyrics' }], cast: [] };
  const mj = { id: 'mj-2022', title: 'MJ', status: 'open', creativeTeam: [{ name: 'Michael Jackson', role: 'Music & Lyrics' }], cast: [] };
  assert.equal(findMatchingShows('Review: Cabaret at Chicago Shakespeare Theater', '/review-cabaret-chicago-shakespeare', [chicago], 'John Kander and Fred Ebb’s Cabaret').length, 0);
  assert.equal(findMatchingShows('Oliver! at the Chichester Festival Theatre', '/oliver-chichester', [oliver], 'Lionel Bart’s musical returns.').length, 0);
  assert.equal(findMatchingShows('Michael: first trailer for the MJ biopic', '/michael-trailer', [mj], 'plays Michael Jackson').length, 0);
});

test('a one-word show is not matched by its composer, lyricist or a biopic subject', () => {
  const mj = { id: 'mj-2022', title: 'MJ', status: 'open', creativeTeam: [{ name: 'Michael Jackson', role: 'Music & Lyrics' }, { name: 'Lynn Nottage', role: 'Book' }], cast: [] };
  assert.equal(namesShowCredit(' michael jackson ', mj), false);
  assert.equal(namesShowCredit(' lynn nottage ', mj), true);
});

test('a short title on a show with no cast or creative data never matches (unchanged behavior)', () => {
  assert.equal(findMatchingShows('Rope at the Hampstead', 'rope-at-the-hampstead', [noCredits]).length, 0);
});

test('credit for one show does not leak onto another short-title show', () => {
  const rope = { id: 'rope', title: 'Rope', status: 'open', creativeTeam: [{ name: 'Patrick Hamilton', role: 'Playwright' }], cast: [] };
  assert.deepEqual(ids(findMatchingShows('Melis Aker’s Fish and Patrick Hamilton’s Rope', 'fish-and-rope', [fish, rope])).sort(), ['fish-off-broadway-2026', 'rope']);
  assert.deepEqual(ids(findMatchingShows('Melis Aker’s Fish', 'fish', [fish, rope])), ['fish-off-broadway-2026']);
});

// Off Off Online titles its review just "Fish" and names the playwright only in the
// RSS description. Real shape of that feed item, trimmed.
const { parseRssFeed } = require('./outlet-listing-helpers.js');
const OOO_XML = `<rss><channel><item><title>Fish</title><link>https://www.offoffonline.com/offoffonline/2026/10/7/fish</link>
<pubDate>Tue, 13 Oct 2026 00:15:21 +0000</pubDate>
<description>&lt;p&gt;Fish, written by Melis Aker and directed by Tatiana Pandiani, is a darkly comic coming-of-age drama.&lt;/p&gt;</description></item>
<item><title>Delirium</title><link>https://www.offoffonline.com/offoffonline/2026/9/16/delirium</link><pubDate>Fri, 25 Sep 2026 11:58:32 +0000</pubDate>
<description>&lt;p&gt;A comedy about sleep, with no fish in it.&lt;/p&gt;</description></item></channel></rss>`;

test('parseRssFeed keeps the item description as plain text', () => {
  const items = parseRssFeed(OOO_XML, new Date('2026-01-01'));
  assert.equal(items.length, 2);
  assert.match(items[0].description, /^Fish, written by Melis Aker and directed by Tatiana Pandiani/);
  assert.doesNotMatch(items[0].description, /[<>]/);
});

test('a bare "Fish" headline matches when the feed description names the playwright', () => {
  const [item] = parseRssFeed(OOO_XML, new Date('2026-01-01'));
  const slug = new URL(item.url).pathname;
  assert.deepEqual(ids(findMatchingShows(item.headline, slug, [fish], item.description)), ['fish-off-broadway-2026']);
  assert.equal(findMatchingShows(item.headline, slug, [fish]).length, 0); // no description, no credit, no match
});

test('the description supplies credit only; it can never supply the title', () => {
  assert.equal(findMatchingShows('Delirium', '/offoffonline/2026/9/16/delirium', [fish], 'Melis Aker directed a play about a different show').length, 0);
});

test('a description naming no credit does not rescue a short title', () => {
  assert.equal(findMatchingShows('Fish', '/x/fish', [fish], 'A comedy about sleep, with no fish in it.').length, 0);
});

test('numeric non-breaking-space entities in a description do not hide a name', () => {
  const xml = `<rss><channel><item><title>Fish</title><link>https://x.com/2026/10/7/fish</link><pubDate>Tue, 13 Oct 2026 00:15:21 +0000</pubDate><description>Fish by Melis&#160;Aker, directed by Tatiana Pandiani.</description></item></channel></rss>`;
  const [item] = parseRssFeed(xml, new Date('2026-01-01'));
  assert.equal(findMatchingShows(item.headline, '/2026/10/7/fish', [fish], item.description).length, 1);
});

test('only description or summary is kept, never a full article body', () => {
  const xml = `<rss><channel><item><title>Fish</title><link>https://x.com/a/fish</link><pubDate>Tue, 13 Oct 2026 00:15:21 +0000</pubDate><content:encoded>&lt;p&gt;Melis Aker long body&lt;/p&gt;</content:encoded></item></channel></rss>`;
  const [item] = parseRssFeed(xml, new Date('2026-01-01'));
  assert.equal(item.description, '');
});
