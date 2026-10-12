// BRO-3628 / BRO-4742: a zero-result header search was a dead end. Unscored
// closed shows (live, indexable pages) were left out of search entirely, and
// typos got no help. These pin the archive tier and the "Did you mean" picker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Fuse = require('fuse.js');
const lib = require('../../scripts/lib/show-search-match.js');
const { mergeSearchResults } = lib;
const suggestCloseMatches = (F, shows, q, limit) => lib.suggestCloseMatches(lib.createSuggestionIndex(F, shows), q, limit);

const catalogue = [
  { id: 'hamilton-2015', title: 'Hamilton', slug: 'hamilton', status: 'open' },
  { id: 'shamilton', title: 'Shamilton!', slug: 'shamilton', status: 'announced' },
  { id: 'wicked-2003', title: 'Wicked', slug: 'wicked', status: 'open' },
  { id: 'phantom-1988', title: 'The Phantom of the Opera', slug: 'phantom', status: 'closed', hasScore: true },
  { id: 'les-mis-1987', title: 'Les Miserables', slug: 'les-mis-1987', status: 'closed', hasScore: true },
  { id: 'les-mis-west-end', title: 'Les Misérables', slug: 'les-mis', status: 'open', category: 'west-end' },
  { id: 'the-river-2014', title: 'The River', slug: 'the-river', status: 'closed' },
  { id: 'cats-jellicle', title: 'CATS: The Jellicle Ball', slug: 'cats', status: 'open' },
  { id: 'west-side-story-2020', title: 'West Side Story', slug: 'wss', status: 'closed' },
  { id: 'fleabag-west-end-2019', title: 'Fleabag', slug: 'fleabag', status: 'closed', category: 'west-end', archived: true },
];

test('typos get the right title as a suggestion', () => {
  assert.equal(suggestCloseMatches(Fuse, catalogue, 'hamlton')[0].id, 'hamilton-2015');
  assert.equal(suggestCloseMatches(Fuse, catalogue, 'wicket')[0].id, 'wicked-2003');
  assert.equal(suggestCloseMatches(Fuse, catalogue, 'phantom of the oprea')[0].id, 'phantom-1988');
});

test('multi-word typos match word by word (one typo or swap per word)', () => {
  const shows = [
    ...catalogue,
    { id: 'hp-2018', title: 'Harry Potter and the Cursed Child', slug: 'hp', status: 'open' },
    { id: 'mamma-mia', title: 'Mamma Mia!', slug: 'mamma-mia', status: 'open' },
    { id: 'stranger', title: 'Stranger Things: The First Shadow', slug: 'st', status: 'open' },
    { id: 'oklahoma-2019', title: 'Oklahoma!', slug: 'oklahoma', status: 'closed', hasScore: true },
    { id: 'nature-theater', title: 'Nature Theater of Oklahoma: Pizza, or A Door in the Dark', slug: 'nt', status: 'announced' },
  ];
  assert.equal(suggestCloseMatches(Fuse, shows, 'harry poter cursed chld')[0].id, 'hp-2018');
  assert.equal(suggestCloseMatches(Fuse, shows, 'mamma mia musicall')[0].id, 'mamma-mia');
  assert.equal(suggestCloseMatches(Fuse, shows, 'stranger thigns')[0].id, 'stranger');
  assert.equal(suggestCloseMatches(Fuse, shows, 'oklahomaa revival')[0].id, 'oklahoma-2019', 'shortest title first');
});

test('one suggestion per title, preferring the playing production', () => {
  const out = suggestCloseMatches(Fuse, catalogue, 'les miserbles');
  assert.deepEqual(out.map(s => s.id), ['les-mis-west-end']);
});

test('no suggestion when nothing is close (no nonsense "Did you mean")', () => {
  assert.deepEqual(suggestCloseMatches(Fuse, catalogue, 'simon and garfunkle story'), []);
  assert.deepEqual(suggestCloseMatches(Fuse, catalogue, 'the foreigner'), []);
  assert.deepEqual(suggestCloseMatches(Fuse, catalogue, 'ab'), []);
});

test('unscored closed shows in the archive are found, ranked after scored shows', () => {
  const out = mergeSearchResults(catalogue, 'fleabag', []);
  assert.deepEqual(out.map(s => s.id), ['fleabag-west-end-2019']);
  const mixed = mergeSearchResults(
    [{ id: 'old-a', title: 'Alice in Wonderland', slug: 'a', status: 'closed', archived: true },
     { id: 'new-a', title: 'Alice in Wonderland', slug: 'b', status: 'closed', hasScore: true }],
    'alice in wonderland', []);
  assert.deepEqual(mixed.map(s => s.id), ['new-a', 'old-a']);
});

test('committed header-search-extra.json has the archive and cast sections', async () => {
  const fs = await import('node:fs');
  const read = (rel) => JSON.parse(fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8'));
  const extra = read('public/data/header-search-extra.json');
  const main = read('public/data/search-shows.json');
  const mainIds = new Set(main.map(s => s.id));
  assert.ok(extra.archive.length > 0);
  assert.ok(extra.archive.every(s => s.archived === true && s.status === 'closed' && s.slug && !mainIds.has(s.id)));
  assert.ok(Object.keys(extra.cast).length > 0);
  assert.ok(main.every(s => !('castNames' in s)), 'cast stays out of the shared index');
});
