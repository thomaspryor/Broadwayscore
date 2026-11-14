// BRO-4225: performer searches ("julia louis dre…") returned nothing because
// the header search indexed titles, venues and creative teams but not cast.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { castNamesForSearch, matchesShowCastQuery, mergeSearchResults, MAX_SEARCH_CAST } =
  require('../../scripts/lib/show-search-match.js');

const desert = {
  id: 'other-desert-cities-2026', title: 'Other Desert Cities', slug: 'other-desert-cities', status: 'previews',
  castNames: castNamesForSearch([{ name: 'Julia Louis-Dreyfus', role: 'Polly' }, { name: 'Ed Harris', role: 'Lyman' }]),
};
const hamilton = { id: 'hamilton-2015', title: 'Hamilton', slug: 'hamilton', status: 'open', castNames: 'Miguel Cervantes' };
const oldShow = { id: 'veep-1999', title: 'Seinfeld Live', slug: 'seinfeld-live', status: 'closed', castNames: 'Julia Louis-Dreyfus' };

test('castNamesForSearch keeps top-billed names only and skips junk', () => {
  const cast = Array.from({ length: 12 }, (_, i) => ({ name: `Actor ${i}` }));
  assert.equal(castNamesForSearch(cast).split(', ').length, MAX_SEARCH_CAST);
  assert.equal(castNamesForSearch([{ name: '  ' }, null, { role: 'x' }]), '');
  assert.equal(castNamesForSearch(undefined), '');
});

test('progressive performer queries match the cast name (the logged BRO-4225 queries)', () => {
  for (const q of ['julia louis dre', 'julia louis drey', 'julia louis dreyf', 'julia louis dreyfus', 'Julia Louis-Dreyfus', 'louis-dreyfus']) {
    assert.ok(matchesShowCastQuery(desert, q), q);
  }
});

test('short or cross-name queries do not match cast', () => {
  assert.equal(matchesShowCastQuery(desert, 'ed'), false, 'under 4 letters');
  assert.equal(matchesShowCastQuery(desert, 'dreyfus ed harris'), false, 'spans two names');
  assert.equal(matchesShowCastQuery({ id: 'x', title: 'X' }, 'julia'), false, 'no cast indexed');
});

test('mergeSearchResults returns the show for a performer query, playing productions first', () => {
  const out = mergeSearchResults([oldShow, hamilton, desert], 'julia louis dreyfus', []);
  assert.deepEqual(out.map(s => s.id), ['other-desert-cities-2026', 'veep-1999']);
});

test('title matches rank ahead of cast-only matches, even closed or archived ones', () => {
  const closedTitle = { id: 'anna-christie-1993', title: 'Anna Christie', slug: 'ac', status: 'closed', hasScore: true };
  const archivedTitle = { id: 'anna-karenina-1992', title: 'Anna Karenina', slug: 'ak', status: 'closed', archived: true };
  const castOnly = Array.from({ length: 8 }, (_, i) => ({ id: `play-${i}`, title: `Play ${i}`, slug: `p${i}`, status: 'open', castNames: `Anna Person${i}` }));
  const out = mergeSearchResults([...castOnly, archivedTitle, closedTitle], 'anna', []);
  assert.deepEqual(out.slice(0, 2).map(s => s.id), ['anna-christie-1993', 'anna-karenina-1992']);
  assert.equal(out.length, 8);
});

test('cast matches outrank Fuse hits that matched only venue or creative team', () => {
  const directorHit = { id: 'faith-healer', title: 'Faith Healer', slug: 'fh', status: 'closed', hasScore: true };
  const fuseResults = [{ item: directorHit, matches: [{ key: 'creativeTeamNames' }] }];
  const out = mergeSearchResults([directorHit, hamilton], 'miguel cervant', fuseResults);
  assert.deepEqual(out.map(s => s.id), ['hamilton-2015', 'faith-healer']);
});

