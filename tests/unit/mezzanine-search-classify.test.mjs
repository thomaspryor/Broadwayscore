import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyProduction, slugify, buildStubId, productionToCandidate, rankCandidates, normalizeQuery } from '../../supabase/functions/mezzanine-search/classify.mjs';

test('classifyProduction routes by theater location/country (parity with mezzanine-classify.js)', () => {
  assert.equal(classifyProduction({ theater: { isBroadway: true } }), 'broadway');
  assert.equal(classifyProduction({ theater: { location: 'New York', geocodedCity: 'New York' } }), 'off-broadway');
  assert.equal(classifyProduction({ theater: { location: 'London' } }), 'west-end');
  assert.equal(classifyProduction({ theater: { geocodedCountryCode: 'GB' } }), 'uk-regional');
  assert.equal(classifyProduction({ theater: { geocodedCountryCode: 'US' } }), 'us-regional');
  assert.equal(classifyProduction({ theater: {} }), 'other');
});

test('slugify matches scripts/lib/mezzanine-classify.js output', () => {
  assert.equal(slugify('Café Müller'), 'cafe-muller');
  assert.equal(slugify("Bonnie & Clyde"), 'bonnie-and-clyde');
  assert.equal(slugify("Schmigadoon!"), 'schmigadoon');
});

test('buildStubId matches buildDiarySlug()\'s <slug>-<category>-mz<id> pattern', () => {
  assert.equal(buildStubId('Weer', 'off-broadway', 'XVIBxhXTXX'), 'weer-off-broadway-mzXVIBxhXTXX');
});

test('productionToCandidate returns null for Broadway (would create an undrainable stub)', () => {
  assert.equal(productionToCandidate({ show: { name: 'X' }, theater: { isBroadway: true } }), null);
});

test('productionToCandidate returns null when the show name is missing', () => {
  assert.equal(productionToCandidate({ theater: {} }), null);
});

test('productionToCandidate maps a real off-Broadway production, id matches buildStubId', () => {
  const c = productionToCandidate({
    show: { name: 'Cocktail Magique', objectId: 'showABC' },
    theater: { name: 'SoHo Playhouse', geocodedCity: 'New York', geocodedCountryCode: 'US' },
    objectId: 'prodXYZ',
    ratingsCount: 12,
    opened: { iso: '2023-05-01T00:00:00.000Z' },
  });
  assert.equal(c.title, 'Cocktail Magique');
  assert.equal(c.category, 'off-broadway');
  assert.equal(c.mezzProdId, 'prodXYZ');
  assert.equal(c.mezzShowId, 'showABC');
  assert.equal(c.id, 'cocktail-magique-off-broadway-mzprodXYZ');
  assert.equal(c.openingDate, '2023-05-01');
  assert.equal(c.ratingsCount, 12);
});

test('rankCandidates puts near-market (off-broadway/west-end) ahead of regional, then popularity, then recency', () => {
  const candidates = [
    { id: 'a', category: 'us-regional', ratingsCount: 999, openingDate: '2026-01-01' },
    { id: 'b', category: 'off-broadway', ratingsCount: 1, openingDate: '2020-01-01' },
    { id: 'c', category: 'off-broadway', ratingsCount: 50, openingDate: '2021-01-01' },
  ];
  const ranked = rankCandidates(candidates, 10).map(c => c.id);
  assert.deepEqual(ranked, ['c', 'b', 'a']);
});

test('rankCandidates caps to the limit', () => {
  const candidates = Array.from({ length: 15 }, (_, i) => ({ id: String(i), category: 'other', ratingsCount: 0, openingDate: null }));
  assert.equal(rankCandidates(candidates, 10).length, 10);
});

test('normalizeQuery strips curly quotes/ampersand like ImportShows.tsx normTitle, keeps a single space between words', () => {
  assert.equal(normalizeQuery('Guys & Dolls'), 'guys and dolls');
  assert.equal(normalizeQuery('CATS: “The Jellicle Ball”'), 'cats the jellicle ball');
  // Regression (card 174): a stripped-space query finds 0 shows against
  // Mezzanine's searchableName field — verified live against theaterdiary.com
  // 2026-07-14 ('cocktailmagique' → 0 results, 'cocktail magique' → 10).
  assert.equal(normalizeQuery('Cocktail Magique'), 'cocktail magique');
});

test('rankCandidates collapses Mezzanine duplicate records (same title+venue+year, casing/leading-the variants)', () => {
  // Owner repro 2026-07-19: 14 copies of "The Trouble With Dead Boyfriends" and
  // 3 of "I Mostly Blame Myself", all at the Players Theatre with venue-string
  // variants only — the Find-it picker showed them all as identical rows.
  const dupes = [
    { title: 'I Mostly Blame Myself', venue: 'The players theatre', category: 'off-broadway', openingDate: null, ratingsCount: 0, id: 'a' },
    { title: 'I Mostly Blame Myself', venue: 'The Players Theatre', category: 'off-broadway', openingDate: null, ratingsCount: 2, id: 'c' },
    { title: 'I Mostly Blame Myself', venue: 'The Players Theatre', category: 'off-broadway', openingDate: null, ratingsCount: 0, id: 'b' },
    { title: 'The Trouble With Dead Boyfriends', venue: 'Players Theatre', category: 'off-broadway', openingDate: '2007-07-13', ratingsCount: 0, id: 'd' },
    { title: 'The Trouble With Dead Boyfriends', venue: 'The Players Theatre', category: 'off-broadway', openingDate: '2007-07-13', ratingsCount: 0, id: 'e' },
    { title: 'The Trouble With Dead Boyfriends', venue: 'Players Theatre', category: 'off-broadway', openingDate: '2024-06-01', ratingsCount: 0, id: 'f' },
  ];
  const out = rankCandidates(dupes, 10);
  // One Blame copy (the highest-rated), and BOTH Boyfriends years (real revivals survive)
  assert.deepStrictEqual(out.map(c => c.id), ['c', 'f', 'd']);
});
