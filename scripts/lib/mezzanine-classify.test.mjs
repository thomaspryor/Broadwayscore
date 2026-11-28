import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyProduction, slugify, productionToDiaryEntry, buildDiarySlug } = require('./mezzanine-classify.js');

test('classifyProduction routes by theater location/country', () => {
  assert.equal(classifyProduction({ theater: { isBroadway: true } }), 'broadway');
  assert.equal(classifyProduction({ theater: { location: 'New York', geocodedCity: 'New York' } }), 'off-broadway');
  assert.equal(classifyProduction({ theater: { geocodedCity: 'Brooklyn' } }), 'off-broadway');
  assert.equal(classifyProduction({ theater: { location: 'London' } }), 'west-end');
  assert.equal(classifyProduction({ theater: { geocodedCountryCode: 'GB' } }), 'uk-regional');
  assert.equal(classifyProduction({ theater: { geocodedCountryCode: 'US' } }), 'us-regional');
  assert.equal(classifyProduction({ theater: { geocodedCountryCode: 'NL' } }), 'international');
  assert.equal(classifyProduction({ theater: {} }), 'other');
});

test('slugify strips diacritics, punctuation, and normalizes case', () => {
  assert.equal(slugify('Café Müller'), 'cafe-muller');
  assert.equal(slugify("Bonnie & Clyde"), 'bonnie-and-clyde');
  assert.equal(slugify("Schmigadoon!"), 'schmigadoon');
  assert.equal(slugify("  Weer  "), 'weer');
});

test('productionToDiaryEntry returns null for Broadway (belongs in shows.json)', () => {
  assert.equal(productionToDiaryEntry({ show: { name: 'X' }, theater: { isBroadway: true } }), null);
});

test('productionToDiaryEntry returns null when the show name is missing', () => {
  assert.equal(productionToDiaryEntry({ theater: {} }), null);
});

test('productionToDiaryEntry maps a real off-Broadway production shape', () => {
  const entry = productionToDiaryEntry({
    show: { name: 'Weer' },
    theater: { name: 'Cherry Lane Theatre', location: 'New York', geocodedCity: 'New York', geocodedCountryCode: 'US' },
    objectId: 'XVIBxhXTXX',
    ratingsCount: 5,
    averageRating: 4,
  });
  assert.equal(entry.title, 'Weer');
  assert.equal(entry.category, 'off-broadway');
  assert.equal(entry.mezzanineId, 'XVIBxhXTXX');
  assert.equal(entry.audienceScore, 80);
  assert.equal(entry.audienceRatingsCount, 5);
});

test('buildDiarySlug matches the card-specified <slug>-<category>-mz<id> pattern', () => {
  assert.equal(buildDiarySlug('Weer', 'off-broadway', 'XVIBxhXTXX', new Set()), 'weer-off-broadway-mzXVIBxhXTXX');
});

test('buildDiarySlug avoids collisions by appending a numeric suffix', () => {
  const used = new Set(['weer-off-broadway-mzXVIBxhXTXX']);
  assert.equal(buildDiarySlug('Weer', 'off-broadway', 'XVIBxhXTXX', used), 'weer-off-broadway-mzXVIBxhXTXX-2');
});
