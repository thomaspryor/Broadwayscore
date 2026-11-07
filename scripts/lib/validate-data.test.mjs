// BRO-4567: validate-data.js's show-title gate (validateShowTitles) asks
// normalizeShowTitle() whether a stored title is correct. These tests pin the
// Roman-numeral-case step it gained ("Richard Ii" -> "Richard II") by
// require()-ing the real functions, plus a corpus check that no stored title
// currently trips it (the gate errors, so a hit would fail every run).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { fixMisCasedRomanNumerals } = require('./title-display-case.js');
const { normalizeShowTitle, buildVenueVocabulary } = require('./show-title-normalize.js');
const { slugToTitle } = require('./we-listing-discover.js');

const here = path.dirname(fileURLToPath(import.meta.url));

test('title-cased Roman numerals are upper-cased', () => {
  assert.deepEqual(fixMisCasedRomanNumerals('Richard Ii'), { title: 'Richard II', tokens: ['Ii'] });
  assert.equal(fixMisCasedRomanNumerals('Henry Viii').title, 'Henry VIII');
  assert.equal(fixMisCasedRomanNumerals('Louis Xiv Returns').title, 'Louis XIV Returns');
  assert.equal(fixMisCasedRomanNumerals('Henry Iv, Part Ii').title, 'Henry IV, Part II');
  assert.equal(fixMisCasedRomanNumerals("Henry Viii's Wives").title, "Henry VIII's Wives");
  assert.equal(fixMisCasedRomanNumerals('Rocky Ii (Revival)').title, 'Rocky II (Revival)');
});

test('Vi/Xi are numerals right after a regnal name', () => {
  assert.equal(fixMisCasedRomanNumerals('Henry Vi, Part One').title, 'Henry VI, Part One');
  assert.equal(fixMisCasedRomanNumerals('Louis Xi').title, 'Louis XI');
});

test('correct, ambiguous and non-numeral tokens are left alone', () => {
  for (const t of [
    'Richard II', 'Henry VIII', 'V for Vendetta', 'Malcolm X',
    'Vi and the Mountain', 'Xi', 'The Mix', 'Civil War', 'Ivy', 'Dixie',
    'part ii', 'Iiv', 'Ixx', 'I Am My Own Wife', '', 'Ii2',
  ]) {
    const r = fixMisCasedRomanNumerals(t);
    assert.equal(r.title, t, t);
    assert.deepEqual(r.tokens, [], t);
  }
  assert.deepEqual(fixMisCasedRomanNumerals(null), { title: null, tokens: [] });
});

test('normalizeShowTitle reports a roman-numeral-case step (what validate-data errors on)', () => {
  const r = normalizeShowTitle({ id: 'richard-ii-off-west-end-2026', title: 'Richard Ii', venue: 'Orange Tree Theatre' });
  assert.equal(r.changed, true);
  assert.equal(r.title, 'Richard II');
  assert.equal(r.manualReview, false);
  assert.deepEqual(r.steps.map(s => s.kind), ['roman-numeral-case']);
});

test('roman step composes with venue-suffix strip and is idempotent', () => {
  const show = { id: 'x', title: 'Richard Ii (Orange Tree Theatre)', venue: 'Orange Tree Theatre' };
  const r = normalizeShowTitle(show);
  assert.equal(r.title, 'Richard II');
  assert.deepEqual(r.steps.map(s => s.kind), ['venue-suffix', 'roman-numeral-case']);
  const again = normalizeShowTitle({ ...show, title: r.title });
  assert.equal(again.changed, false);
});

test('WE listing slugToTitle no longer mints "Richard Ii"', () => {
  assert.equal(slugToTitle('richard-ii'), 'Richard II');
  assert.equal(slugToTitle('henry-viii'), 'Henry VIII');
  assert.equal(slugToTitle('how-the-other-half-loves'), 'How the Other Half Loves');
});

test('validate-data.js routes titles through normalizeShowTitle (the gate under test)', () => {
  const src = fs.readFileSync(path.join(here, '..', 'validate-data.js'), 'utf8');
  assert.match(src, /const result = normalizeShowTitle\(show, \{ venueVocabulary \}\);/);
});

test('real shows.json: no stored title has a mis-cased Roman numeral', (t) => {
  const p = path.join(here, '..', '..', 'data', 'shows.json');
  if (!fs.existsSync(p)) return t.skip('data/shows.json not present (private core data)');
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  const shows = Array.isArray(raw) ? raw : raw.shows;
  const vocab = buildVenueVocabulary(shows);
  const hits = shows
    .filter(s => s && typeof s.title === 'string')
    .filter(s => normalizeShowTitle(s, { venueVocabulary: vocab }).steps.some(st => st.kind === 'roman-numeral-case'))
    .map(s => `${s.id}: ${s.title}`);
  assert.deepEqual(hits, []);
  const rii = shows.find(s => s.id === 'richard-ii-off-west-end-2026');
  if (rii) assert.equal(rii.title, 'Richard II');
});
