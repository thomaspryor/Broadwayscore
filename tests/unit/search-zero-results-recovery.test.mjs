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

// Ship-check on the landed version (BRO-3628): exact archive titles fell past
// the 8-slot cut behind fuzzy live hits ("art" -> Tartuffe), and a typo of an
// archive title ("fleabg") got only fuzzy noise. Run against the real index.
test('real index: exact titles lead, archive typos are rescued, misses are flagged', async () => {
  const fs = await import('node:fs');
  const read = (rel) => JSON.parse(fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8'));
  const data = lib.withHeaderSearchExtra(read('public/data/search-shows.json'), read('public/data/header-search-extra.json'));
  const fuse = new Fuse(data.filter(s => !s.archived), lib.HEADER_FUSE_OPTIONS);
  const sIndex = lib.createSuggestionIndex(Fuse, data);
  const search = (q) => mergeSearchResults(data, q, fuse.search(q, { limit: 8 }), 8,
    () => lib.suggestCloseMatches(sIndex, q, 3));
  const norm = (t) => lib.normalizeSearchText(t);
  for (const q of ['Art', 'The Chairs', 'The Miser', 'Big', 'Honour', 'Fleabag', 'Ruthless']) {
    const out = search(q);
    assert.ok(norm(out[0].title).startsWith(norm(q)), `${q}: got ${out.slice(0, 3).map(s => s.title)}`);
    assert.equal(out.confident, true);
  }
  const alice = search('alice').slice(0, 3);
  assert.ok(alice.every(s => /alice/i.test(s.title)), `alice: ${alice.map(s => s.title)}`);
  assert.equal(norm(search('fleabg')[0].title), 'fleabag');
  assert.ok(norm(search('ruthles')[0].title).startsWith('ruthless'));
  assert.equal(norm(search('hamiltn')[0].title), 'hamilton');
  assert.equal(search('christopher jackso')[0].id, 'hamilton-2015');
  // Only fuzzy guesses (or nothing): HeaderSearch logs these as misses.
  assert.equal(search('simon and garfunkel story').confident, false);
  // Venue and creator searches are answers, not misses, and must not be
  // pre-empted by a typo guess ("majestic" -> Masticate) (ship-check P2).
  for (const [q, venueOrCreator] of [['majestic', 'majestic'], ['st james', 'stjames'], ['jason robert brown', 'jasonrobertbrown']]) {
    const out = search(q);
    assert.equal(out.confident, true, q);
    const top = out[0];
    const fields = [top.venue, ...(top.creativeTeamNames || '').split(',')];
    assert.ok(fields.some(f => lib.normalizeSearchText(f).includes(venueOrCreator)), `${q} -> ${top.title}`);
  }
  // A title typo that is part of a creator's name (Vaccariello, Binkley,
  // McNally) must still reach the typo fix, and a bare name fragment is
  // not a venue/creator answer (ship-check P1).
  for (const [q, want] of [['carie', 'carrie'], ['bink', 'blink'], ['mcnal', 'mcneal']]) {
    assert.ok(search(q).some(s => norm(s.title).startsWith(want)), `${q} -> ${want}`);
  }
  assert.equal(lib.matchesShowPlaceOrCreatorQuery({ venue: 'Majestic Theatre', creativeTeamNames: 'Howell Binkley' }, 'bink'), false);
  assert.equal(lib.matchesShowPlaceOrCreatorQuery({ venue: 'Majestic Theatre', creativeTeamNames: 'Howell Binkley' }, 'howell bink'), true);
});

test('exact archive titles are found by typing them (every 8th, plus the old misses)', async () => {
  const fs = await import('node:fs');
  const read = (rel) => JSON.parse(fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8'));
  const data = lib.withHeaderSearchExtra(read('public/data/search-shows.json'), read('public/data/header-search-extra.json'));
  const fuse = new Fuse(data.filter(s => !s.archived), lib.HEADER_FUSE_OPTIONS);
  // The full 1,278 take ~80s; a fixed stride plus the titles the landed
  // version lost keeps this a fast unit test.
  const known = new Set(['Art', 'The Chairs', 'The Miser', 'Big', 'Honour', 'Cyrano - The Musical']);
  const sample = data.filter(s => s.archived).filter((s, i) => i % 8 === 0 || known.has(s.title));
  const missing = sample.filter(s => {
    const out = mergeSearchResults(data, s.title, fuse.search(s.title, { limit: 8 }), 8);
    return !out.some(r => lib.normalizeSearchText(r.title) === lib.normalizeSearchText(s.title));
  });
  assert.deepEqual(missing.map(s => s.title), []);
});
