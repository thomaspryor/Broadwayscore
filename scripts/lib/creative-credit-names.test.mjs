import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { creativeCreditNames } = require('./creative-credit-names');
const { creativeNamesInPageOrder } = require('./page-name-sources');
const { buildNameSlugRedirects } = require('./name-slug-redirects');

test('splits pairs, Oxford lists and mixed separators in credit order', () => {
  assert.deepEqual(creativeCreditNames('Betty Comden and Adolph Green'), ['Betty Comden', 'Adolph Green']);
  assert.deepEqual(creativeCreditNames('Tye Blue, Marla Mindelle, and Constantine Rousouli'), ['Tye Blue', 'Marla Mindelle', 'Constantine Rousouli']);
  assert.deepEqual(creativeCreditNames('Ava Able with Bob Baker & Carol Clark'), ['Ava Able', 'Bob Baker', 'Carol Clark']);
  assert.deepEqual(creativeCreditNames('Stew and Heidi Rodewald'), ['Stew', 'Heidi Rodewald']);
  assert.deepEqual(creativeCreditNames('Brian Wilson and The Beach Boys'), ['Brian Wilson', 'The Beach Boys']);
});

test('preserves suffix spelling and single names, including commas', () => {
  assert.deepEqual(creativeCreditNames('Alain Boublil and Richard Maltby, Jr'), ['Alain Boublil', 'Richard Maltby, Jr']);
  assert.deepEqual(creativeCreditNames('Richard Maltby, Jr., and Jane Smith'), ['Richard Maltby, Jr.', 'Jane Smith']);
  for (const name of ['Richard Maltby, Jr.', 'Anderson Cooper', 'constructor']) assert.deepEqual(creativeCreditNames(name), [name]);
});

test('keeps ambiguous and company names intact', () => {
  for (const name of ['ABBA (Benny Andersson & Björn Ulvaeus)', 'Bob & Bill', 'Max Martin and Friends', 'Smith and Jones Productions', 'Special Arrangement with', 'Jane Smith and']) {
    assert.deepEqual(creativeCreditNames(name), [name]);
  }
});

test('expands shared-name credits without creating first-name-only pages', () => {
  assert.deepEqual(creativeCreditNames('Keone & Mari Madrid'), ['Keone Madrid', 'Mari Madrid']);
  assert.deepEqual(creativeCreditNames('Rodgers & Hart and George Abbott'), ['Richard Rodgers', 'Lorenz Hart', 'George Abbott']);
});

const shows = [
  { id: 'one-2000', category: 'broadway', creativeTeam: [
    { name: 'José Writer and Jane Smith', role: 'book writer' },
    { name: 'Jane Smith', role: 'Lyrics' },
    { name: 'No Page and Another Person', role: 'Scenic Design' },
  ] },
  { id: 'two-2001', category: 'broadway', creativeTeam: [
    { name: 'Jose Writer', role: 'Book' },
    { name: 'David Newman, Ira Gasman and Cy Coleman', role: 'Book' },
    { name: 'David Newman , Ira Gasman and Cy Coleman', role: 'Lyrics' },
  ] },
  { id: 'excluded-2000', category: 'west-end', creativeTeam: [{ name: 'Outside Person and Another Writer', role: 'Book' }] },
];

test('existing individuals keep page order ahead of new names; retired replay keeps original team order', () => {
  assert.deepEqual(creativeNamesInPageOrder(shows.slice(0, 2)), ['Jane Smith', 'Jose Writer', 'José Writer', 'David Newman', 'Ira Gasman', 'Cy Coleman']);
  assert.equal(creativeNamesInPageOrder(shows, { splitTeams: false })[0], 'José Writer and Jane Smith');
});

test('both accent generations of team URLs redirect straight to the first individual, with collision suffixes', () => {
  const { entries } = buildNameSlugRedirects({ shows });
  assert.equal(entries['creative:jose-writer-and-jane-smith'], 'jose-writer-2');
  assert.equal(entries['creative:jos-writer-and-jane-smith'], 'jose-writer-2');
  assert.equal(entries['creative:david-newman-ira-gasman-and-cy-coleman'], 'david-newman');
  assert.equal(entries['creative:david-newman-ira-gasman-and-cy-coleman-2'], 'david-newman');
  assert.equal(entries['creative:jose-writer'], undefined, 'existing individual URL stays live');
  assert.ok(!Object.keys(entries).some(k => /no-page|outside-person/.test(k)));
  for (const value of Object.values(entries)) assert.equal(entries[`creative:${value}`], undefined, 'no redirect chains');
});

test('a retired team slug cannot shadow a different live page', () => {
  const { entries } = buildNameSlugRedirects({ shows: [{ category: 'broadway', creativeTeam: [
    { name: 'Jane-Smith-and-Bob-Baker', role: 'Book' },
    { name: 'Jane Smith and Bob Baker', role: 'Book' },
  ] }] });
  assert.equal(entries['creative:jane-smith-and-bob-baker'], undefined);
  assert.equal(entries['creative:jane-smith-and-bob-baker-2'], 'jane-smith');
});
