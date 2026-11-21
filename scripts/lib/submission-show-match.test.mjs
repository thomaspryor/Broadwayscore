// BRO-4141: issue #919 ("Thelma and Louise") was matched to "Ma" (ma-1971)
// by a raw-substring matcher and sent to manual review, while the real
// production ("Thelma & Louise: A New Musical") was missed over "&" vs "and".
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findMatchingShows } = require('./submission-show-match.js');

const SHOWS = [
  { id: 'ma-1971', title: 'Ma' },
  { id: 'thelma-and-louise-a-new-musical-off-west-end-2026', title: 'Thelma & Louise: A New Musical' },
  { id: 'golden-boy-2012', title: 'Golden Boy' },
  { id: 'golden-boy-off-west-end-2026', title: 'Golden Boy' },
  { id: 'hair-2009', title: 'Hair' },
  { id: 'hairspray-2002', title: 'Hairspray' },
  { id: 'les-miserables-2014', title: 'Les Misérables' },
];
const ids = (name) => findMatchingShows(name, SHOWS).map((s) => s.id);

test('"Thelma and Louise" finds the musical, not "Ma"', () => {
  assert.deepEqual(ids('Thelma and Louise'), ['thelma-and-louise-a-new-musical-off-west-end-2026']);
});

test('exact title returns every production with that title', () => {
  assert.deepEqual(ids('Golden Boy'), ['golden-boy-2012', 'golden-boy-off-west-end-2026']);
});

test('exact normalized match wins over partials ("Hair" is not "Hairspray")', () => {
  assert.deepEqual(ids('Hair'), ['hair-2009']);
});

test('a title that is also one production\'s slug still returns every production', () => {
  const shows = [
    { id: 'ragtime-1998', slug: 'ragtime-1998', title: 'Ragtime' },
    { id: 'ragtime-2025', slug: 'ragtime', title: 'Ragtime' },
  ];
  assert.deepEqual(findMatchingShows('Ragtime', shows).map((s) => s.id), ['ragtime-1998', 'ragtime-2025']);
});

test('slug input matches its show', () => {
  assert.deepEqual(ids('hairspray-2002'), ['hairspray-2002']);
});

test('diacritics and punctuation are normalized', () => {
  assert.deepEqual(ids('Les Miserables'), ['les-miserables-2014']);
});

test('a short title only matches as a whole word, never inside another word', () => {
  assert.deepEqual(ids('Thelma'), ['thelma-and-louise-a-new-musical-off-west-end-2026']);
  assert.deepEqual(ids('Mama Mia'), []);
});

test('shorthand and short-title-first names still match (ship-check)', () => {
  const shows = [
    { id: 'six-2021', title: 'Six' },
    { id: 'broadway-1987', title: 'Broadway' },
    { id: 'les-miserables-2014', title: 'Les Misérables' },
    { id: 'cats-west-end-2014', title: 'Cats' },
  ];
  const got = (n) => findMatchingShows(n, shows).map((s) => s.id);
  assert.ok(got('Six on Broadway').includes('six-2021'));
  assert.deepEqual(got('Les Mis'), ['les-miserables-2014']);
  assert.deepEqual(got('Cats West End'), ['cats-west-end-2014']);
});

test('empty input matches nothing', () => {
  assert.deepEqual(ids(''), []);
  assert.deepEqual(ids(null), []);
});

// Issue #1178: a Nov 2026 review of "Waiting for Lefty" must prefer the 2026
// off-Broadway production over the closed 2024 regional one with the same title.
{
  const { preferProductionByDate } = require('./submission-show-match.js');
  const regional = { id: 'waiting-for-lefty-regional-2024', title: 'Waiting for Lefty', openingDate: '2024-02-04', closingDate: '2024-02-24' };
  const offB = { id: 'clifford-odets-waiting-for-lefty-off-broadway-2026', title: 'Clifford Odets’ Waiting for Lefty', openingDate: '2026-11-02', closingDate: '2026-12-06' };
  const other = { id: 'unrelated-show', title: 'Hamilton', openingDate: '2026-10-01' };

  test('preferProductionByDate: re-matches to the production whose run window fits the review date', () => {
    const r = preferProductionByDate({ show: regional, showName: 'Waiting for Lefty', shows: [regional, offB, other], reviewDate: '2026-11-02' });
    assert.equal(r.id, offB.id);
  });
  test('preferProductionByDate: keeps the show when its window fits, the date is unknown, or no alternative fits', () => {
    assert.equal(preferProductionByDate({ show: regional, showName: 'Waiting for Lefty', shows: [regional, offB], reviewDate: '2024-02-10' }).id, regional.id);
    assert.equal(preferProductionByDate({ show: regional, showName: 'Waiting for Lefty', shows: [regional, offB], reviewDate: null }).id, regional.id);
    assert.equal(preferProductionByDate({ show: regional, showName: 'Waiting for Lefty', shows: [regional, other], reviewDate: '2026-11-02' }).id, regional.id);
  });
  test('preferProductionByDate: never guesses between two fitting alternatives', () => {
    const offB2 = { ...offB, id: 'waiting-for-lefty-other-2026' };
    assert.equal(preferProductionByDate({ show: regional, showName: 'Waiting for Lefty', shows: [regional, offB, offB2], reviewDate: '2026-11-02' }).id, regional.id);
  });
}

test('reviewDateFitsShow: previews start counts, closed show without closingDate is unknown', () => {
  const { reviewDateFitsShow } = require('./submission-show-match.js');
  assert.equal(reviewDateFitsShow({ openingDate: '2026-06-01', previewsStartDate: '2026-02-01' }, '2026-03-01'), true);
  assert.equal(reviewDateFitsShow({ openingDate: '2026-06-01' }, '2026-03-01'), false);
  assert.equal(reviewDateFitsShow({ openingDate: '2024-01-01', status: 'closed' }, '2026-03-01'), null);
  assert.equal(reviewDateFitsShow({ openingDate: '2024-01-01', status: 'open' }, '2026-03-01'), true);
});
