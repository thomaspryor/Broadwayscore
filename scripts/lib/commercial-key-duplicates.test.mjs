import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findDuplicateKeyPairs, conflictingFields, isModelStampedField } = require('./commercial-key-duplicates.js');

// Fixture mirroring the real shapes: becky-shaw-2026 is a show ID whose slug
// (becky-shaw) is also a commercial key; mamma-mia-2001 is a show whose SLUG
// is literally mamma-mia-2001 (distinct production from the mamma-mia revival).
const showBySlug = {
  'becky-shaw': { id: 'becky-shaw-2026', slug: 'becky-shaw' },
  'mamma-mia': { id: 'mamma-mia-2025', slug: 'mamma-mia' },
  // Real shows.json shape: mamma-mia-2001's id EQUALS its slug. The fixture
  // must mirror that — an invented distinct id made this guard test vacuous
  // (deleting the predicate's slug-check clause still passed all tests).
  'mamma-mia-2001': { id: 'mamma-mia-2001', slug: 'mamma-mia-2001' },
  'lempicka': { id: 'lempicka-2024', slug: 'lempicka' },
  'hamilton': { id: 'hamilton-2015', slug: 'hamilton' },
};
const showById = {};
for (const s of Object.values(showBySlug)) showById[s.id] = s;

test('detects a real ID-keyed duplicate pair (becky-shaw case)', () => {
  const pairs = findDuplicateKeyPairs(
    { 'becky-shaw': {}, 'becky-shaw-2026': {} },
    showBySlug,
    showById
  );
  assert.deepEqual(pairs, [{ idKey: 'becky-shaw-2026', slugKey: 'becky-shaw' }]);
});

test('never matches a legit distinct-production slug that looks like an ID (mamma-mia-2001)', () => {
  // mamma-mia-2001 IS a slug in shows.json (with id === slug) — it must be
  // excluded even though mamma-mia is also present. A "-YYYY suffix"
  // heuristic would fail here.
  const pairs = findDuplicateKeyPairs(
    { 'mamma-mia': {}, 'mamma-mia-2001': {} },
    showBySlug,
    showById
  );
  assert.deepEqual(pairs, []);
});

test('a key whose show has id === slug can never self-pair, even without a slug-map entry', () => {
  // Defense-in-depth for the mamma-mia-2001 shape: if the slug lookup ever
  // missed (partial map, regressed clause), the id lookup alone must not
  // produce a {idKey: X, slugKey: X} self-pair — that would let --apply
  // delete the show's ONLY commercial entry.
  const pairs = findDuplicateKeyPairs(
    { 'mamma-mia-2001': {} },
    {}, // slug map empty — simulates the clause-1 lookup missing entirely
    { 'mamma-mia-2001': { id: 'mamma-mia-2001', slug: 'mamma-mia-2001' } }
  );
  assert.deepEqual(pairs, []);
});

test('plain id-mismatch without a slug sibling is NOT a pair', () => {
  // lempicka-2024 keyed alone (no lempicka key) — id-mismatch, not a duplicate.
  const pairs = findDuplicateKeyPairs({ 'lempicka-2024': {} }, showBySlug, showById);
  assert.deepEqual(pairs, []);
});

test('orphan keys (in neither slug nor id) are ignored', () => {
  const pairs = findDuplicateKeyPairs({ 'not-a-show': {}, 'hamilton': {} }, showBySlug, showById);
  assert.deepEqual(pairs, []);
});

test('conflictingFields: empty when ID entry is contained in slug entry', () => {
  const idE = {
    designation: 'Flop',
    sources: [{ url: 'https://a.example' }],
    notes: 'closed early',
    modelRecouped: false,
    lastUpdated: '2026-07-01',
  };
  const slugE = {
    designation: 'Flop',
    sources: [{ url: 'https://a.example' }, { url: 'https://b.example' }],
    notes: 'closed early. Merged 2026-07-19.',
    modelRecouped: true, // model fields ignored
  };
  assert.deepEqual(conflictingFields(idE, slugE), []);
});

test('conflictingFields: reports fields where entries genuinely disagree', () => {
  const idE = { capitalization: 26000000, designation: 'TBD', notes: 'x' };
  const slugE = { capitalization: 24000000, designation: 'TBD', notes: 'x' };
  assert.deepEqual(conflictingFields(idE, slugE), ['capitalization']);
});

test('conflictingFields: field missing from slug entry is a conflict', () => {
  assert.deepEqual(conflictingFields({ costMethodology: 'trade-reported' }, {}), ['costMethodology']);
});

test('conflictingFields: substring containment applies ONLY to notes, not other strings', () => {
  // A recoupedSource URL that is a prefix of the slug entry's is a DIFFERENT
  // value and must conflict — only merged notes legitimately contain the
  // original text as a substring.
  const idE = { recoupedSource: 'https://variety.com/article', notes: 'closed early' };
  const slugE = { recoupedSource: 'https://variety.com/article-updated', notes: 'closed early. Merged.' };
  assert.deepEqual(conflictingFields(idE, slugE), ['recoupedSource']);
});

test('isModelStampedField covers model* and lastUpdated only', () => {
  assert.equal(isModelStampedField('modelRecouped'), true);
  assert.equal(isModelStampedField('modelDesignation'), true);
  assert.equal(isModelStampedField('lastUpdated'), true);
  assert.equal(isModelStampedField('designation'), false);
  assert.equal(isModelStampedField('sources'), false);
});
