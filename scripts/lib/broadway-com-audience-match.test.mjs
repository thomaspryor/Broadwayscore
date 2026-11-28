import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { matchBroadwayComToShows } = require('./broadway-com-audience-match');

const billy = {
  id: 'billy-crystal-860-2026', title: 'Billy Crystal 860', akaTitles: ['860'],
  category: 'broadway', previewsStartDate: '2026-10-01', openingDate: '2026-10-21',
};
const listing = { title: '860', slug: '860', url: 'https://www.broadway.com/shows/860/' };

test('BRO-5950: the live Broadway.com title 860 attaches to Billy Crystal', () => {
  const matches = matchBroadwayComToShows([listing], [billy]);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].show.id, billy.id);
  assert.equal(matches[0].confidence, 'override');
  assert.equal(matches[0].bc.url, listing.url);
});

test('860 override never attaches to another production when its target is absent', () => {
  for (const category of ['off-broadway', 'west-end', 'tour', 'regional']) {
    const other = { ...billy, id: `other-${category}`, category };
    assert.deepEqual(matchBroadwayComToShows([listing], [other]), []);
  }
});

test('the source-specific override does not enable venue-free aliases generally', () => {
  const other = { id: 'other', title: 'Another Press Title', akaTitles: ['Bare Alias'], category: 'broadway' };
  assert.deepEqual(matchBroadwayComToShows([{ title: 'Bare Alias' }], [other]), []);
});

test('existing overrides, exact titles, and subtitle prefixes still attach', () => {
  const shows = [
    { id: 'wanted-2022', title: 'Wanted', akaTitles: ['Gun & Powder'], category: 'broadway' },
    { id: 'hamilton-2015', title: 'Hamilton', category: 'broadway' },
    { id: 'sunset-boulevard-2024', title: 'Sunset Boulevard', category: 'broadway' },
    { id: 'operation-mincemeat-2025', title: 'Operation Mincemeat', category: 'broadway' },
  ];
  const matches = matchBroadwayComToShows([
    { title: 'Wanted' }, { title: 'Hamilton' }, { title: 'Sunset Blvd.' },
    { title: 'Operation Mincemeat: A New Musical' },
  ], shows);
  assert.deepEqual(matches.map(m => [m.show.id, m.confidence]), [
    ['wanted-2022', 'exact'], ['hamilton-2015', 'exact'],
    ['sunset-boulevard-2024', 'override'], ['operation-mincemeat-2025', 'prefix'],
  ]);
});

test('exact titles still prefer the newest started Broadway production', () => {
  const base = { title: 'A Revival', category: 'broadway', openingDate: '2000-01-01' };
  const shows = [
    { ...base, id: 'old' },
    { ...base, id: 'recent', openingDate: '2001-01-01' },
    { ...base, id: 'future', openingDate: '2099-01-01' },
    { ...base, id: 'london', category: 'west-end', openingDate: '2002-01-01' },
  ];
  const matches = matchBroadwayComToShows([{ title: base.title }], shows);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].show.id, 'recent');
});
