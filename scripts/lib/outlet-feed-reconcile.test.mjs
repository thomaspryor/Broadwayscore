// BRO-5358: feed-vs-corpus reconcile. require()s the real functions (CLAUDE.md §15).
// Fish names, dates and URLs below are the two real feed items from BRO-5326.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { readinessVerdict, reconcileFeedItems, recentlyOpenedShows, digestItems, urlKey } = require('./outlet-feed-reconcile.js');
const NOW = Date.parse('2026-10-14T12:00:00Z');

const fish = {
  id: 'fish-off-broadway-2026', title: 'Fish', status: 'open', venue: 'WP Theater', previewsStartDate: '2026-09-26', openingDate: '2026-10-11', isRevival: false,
  creativeTeam: [{ name: 'Melis Aker', role: 'Playwright' }, { name: 'Tatiana Pandiani', role: 'Director' }], cast: [],
};
const old = { id: 'old-show', title: 'Old Show', status: 'open', openingDate: '2026-08-01' };
const soon = { id: 'soon-off-broadway-2026', title: 'Soon', venue: "St. Luke's Theatre", status: 'open', openingDate: '2026-10-05', cast: [], creativeTeam: [] };
const active = [fish, old, soon];
const items = [
  { outletId: 'theater-pizzazz', url: 'https://theaterpizzazz.com/fish-review/?utm=x', headline: 'Review: Fish', publishDate: '2026-10-12', description: 'Melis Aker’s new play at WP Theater.' },
  { outletId: 'off-off-online', url: 'https://offoffonline.com/reviews/fish', headline: 'Fish', publishDate: '2026-10-12', description: 'Directed by Tatiana Pandiani.' },
  { outletId: 'guardian', url: 'https://theguardian.com/best-fish-and-chips', headline: 'The best fish and chips', publishDate: '2026-10-12', description: '' },
];
const run = (known, extra = {}) => reconcileFeedItems({ activeShows: active, targetShows: [fish], items, knownUrls: known, nowMs: NOW, ...extra });

test('a corpus that holds both Fish reviews reports no gaps', () => {
  const r = run({ [fish.id]: ['https://www.theaterpizzazz.com/fish-review', 'http://offoffonline.com/reviews/fish/'] });
  assert.deepEqual(r.gaps, []);
});

test('with the two review files removed it reports exactly those two', () => {
  const r = run({ [fish.id]: [] });
  assert.equal(r.matchedCount, 2);
  assert.deepEqual(r.gaps.filter((g) => g.level === 'matched').map((g) => g.outletId).sort(), ['off-off-online', 'theater-pizzazz']);
});

test('a flagged or rejected URL counts as known (any file, flagged or not)', () => {
  const r = run({ [fish.id]: ['https://theaterpizzazz.com/fish-review'] });
  assert.deepEqual(r.gaps.map((g) => g.outletId), ['off-off-online']);
});

test('an article about another show is never a gap for this one', () => {
  const r = reconcileFeedItems({ activeShows: active, targetShows: [fish], items: [{ outletId: 'x', url: 'https://x.com/hamilton-review', headline: 'Hamilton review', publishDate: '2026-10-12' }], knownUrls: {}, nowMs: NOW });
  assert.deepEqual(r.gaps, []);
});

test('a title mention the matcher declined is only "possible", and only inside the opening window', () => {
  const loose = { outletId: 'x', url: 'https://x.com/fish-at-wp', headline: 'Fish: a first look at the new play', publishDate: '2026-10-12', description: '' };
  const outside = { ...loose, url: 'https://x.com/fish-march', publishDate: '2026-03-01' };
  const r = reconcileFeedItems({ activeShows: active, targetShows: [fish], items: [loose, outside], knownUrls: {}, nowMs: NOW });
  assert.deepEqual(r.gaps.map((g) => [g.url, g.level]), [['https://x.com/fish-at-wp', 'possible']]);
  assert.equal(r.matchedCount, 0);
});

test('a short-title show with no credits is reconciled through its venue', () => {
  const item = { outletId: 'x', url: 'https://x.com/soon-review', headline: "Soon at St. Luke's Theatre", publishDate: '2026-10-07' };
  const r = reconcileFeedItems({ activeShows: active, targetShows: [soon], items: [item], knownUrls: {}, nowMs: NOW });
  assert.equal(r.matchedCount, 1);
});

test('recentlyOpenedShows keeps only shows opened in the last 7 days', () => {
  assert.deepEqual(recentlyOpenedShows(active, NOW).map((s) => s.id), [fish.id]);
  assert.deepEqual(recentlyOpenedShows(active, NOW, 10).map((s) => s.id), [fish.id, soon.id]);
  assert.deepEqual(recentlyOpenedShows([{ ...fish, status: 'closed' }, { ...fish, id: 'f2', openingDate: null }], NOW), []);
});

test('urlKey ignores scheme, www, query, fragment and trailing slash', () => {
  assert.equal(urlKey('HTTPS://www.Example.com/a/b/?x=1#top'), urlKey('http://example.com/a/b'));
});

test('digestItems lists matched gaps only, one line per show', () => {
  const r = run({ [fish.id]: [] });
  const d = digestItems([...r.gaps, { showId: 'z', title: 'Z', level: 'possible', outletId: 'q' }]);
  assert.equal(d.length, 1);
  assert.match(d[0].detail, /^2 reviews in outlet feeds not ingested/);
});

test('readinessVerdict: warn on matched gaps, pass when clean, skip when nothing was reconciled', () => {
  const gaps = run({ [fish.id]: [] }).gaps;
  const base = { shows: [{ id: fish.id }], itemsScanned: 46, feedsChecked: 20, skipped: [] };
  const warn = readinessVerdict({ ...base, gaps });
  assert.equal(warn.status, 'warn');
  assert.match(warn.detail, /^2 outlet feed item\(s\)/);
  assert.equal(readinessVerdict({ ...base, gaps: [] }).status, 'pass');
  assert.equal(readinessVerdict({ shows: [], skipped: [{ reason: 'no data/review-texts directory for this show' }], gaps: [] }).status, 'skip');
  assert.equal(readinessVerdict(null).status, 'skip');
});

// Live run 2026-10-14: an undated standard.co.uk review of an older "Midnight at the Never Get"
// matched the new Midnight as a gap.
test('an item dated before the opening window is dropped; an undated match is only "possible"', () => {
  const midnight = { id: 'midnight-off-broadway-2026', title: 'Midnight', status: 'open', venue: 'X Theatre', openingDate: '2026-10-08', creativeTeam: [], cast: [] };
  const mk = (url, publishDate) => ({ outletId: 'standard', url, headline: 'Midnight review', publishDate });
  const r = reconcileFeedItems({ activeShows: [midnight], targetShows: [midnight], knownUrls: {}, nowMs: NOW,
    items: [mk('https://s.co.uk/old', '2019-03-01'), mk('https://s.co.uk/undated', null), mk('https://s.co.uk/new', '2026-10-09')] });
  assert.deepEqual(r.gaps.map((g) => [g.url, g.level]), [['https://s.co.uk/new', 'matched'], ['https://s.co.uk/undated', 'possible']]);
});
