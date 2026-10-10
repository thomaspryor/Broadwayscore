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

// BRO-4623 item 4: the two pairs that blocked the 2026-10-03 weekly publish
// (field values abridged from the published commercial.json).
const { isSelfHealablePair } = require('./commercial-key-duplicates.js');

test('self-heal: the-balusters-2026 differs only in notes/sources/firstAdded -> resolvable keeping the slug entry', () => {
  const idE = {
    designation: 'Nonprofit',
    notes: 'Produced by nonprofit MTC with no public budget or running cost data found; designated Nonprofit.',
    sources: [{ type: 'manual', url: 'https://en.wikipedia.org/wiki/The_Balusters', date: null }],
    lastUpdated: '2026-09-26T23:58:37.741Z',
    firstAdded: '2026-09-26T23:58:37.741Z',
  };
  const slugE = {
    designation: 'Nonprofit',
    notes: 'World-premiere David Lindsay-Abaire play at MTC Friedman, directed by Kenny Leon.',
    sources: [],
    nonprofitOrg: 'Manhattan Theatre Club',
    recouped: false,
    lastUpdated: '2026-05-24T15:30:16.089Z',
  };
  const conflicts = conflictingFields(idE, slugE);
  assert.deepEqual(conflicts, ['notes', 'sources', 'firstAdded']);
  assert.equal(isSelfHealablePair(idE, slugE, conflicts), true);
});

test('self-heal: school-girls-or-the-african-mean-girls-play-2026 pair is resolvable too', () => {
  const idE = { designation: 'Nonprofit', notes: 'Produced by Manhattan Theatre Club, a 501(c)(3) nonprofit.', sources: [{ type: 'manual', url: 'https://projects.propublica.org/nonprofits/organizations/237086643', date: '2026-09-28' }], firstAdded: '2026-09-28T20:53:28.126Z' };
  const slugE = { designation: 'Nonprofit', notes: 'School Girls; Or, The African Mean Girls Play is a Manhattan Theatre Club production.', sources: [{ type: 'trade', url: 'https://www.manhattantheatreclub.com/shows/2026-27-season/school-girls-or-the-african-mean-girls-play/', date: '2026-09-14' }], firstAdded: '2026-09-20T19:08:12.779Z' };
  assert.equal(isSelfHealablePair(idE, slugE), true);
});

test('self-heal never covers substantive conflicts: the-outsiders-2024 recoupedSource still refuses', () => {
  // The reconciler wrote the Deadline TOUR article onto the ID key; the slug
  // entry cites the Broadway recoupment. That disagreement is a human call.
  const idE = { recouped: true, recoupedDate: '2026-05', recoupedSource: 'https://deadline.com/2026/05/the-outsiders-broadway-recoup-1236698348/', sources: [], firstAdded: '2026-10-03T22:30:39.000Z' };
  const slugE = { recouped: true, recoupedDate: '2025-12', recoupedSource: 'Broadway News (Jan 27, 2026): recouped its $22M investment', designation: 'Windfall' };
  const conflicts = conflictingFields(idE, slugE);
  assert.ok(conflicts.includes('recoupedSource'));
  assert.equal(isSelfHealablePair(idE, slugE, conflicts), false);
});

test('self-heal: a placeholder TBD designation on the ID key is not a conflict, a real one is', () => {
  const stub = { designation: 'TBD', researchAttempts: 1, lastResearchedAt: '2026-09-26T21:50:20.196Z', researchTrigger: 'queued' };
  assert.equal(isSelfHealablePair(stub, { designation: 'Fizzle', recouped: false }), true);
  assert.equal(isSelfHealablePair({ designation: 'Flop' }, { designation: 'Fizzle' }), false);
  assert.equal(isSelfHealablePair({ designation: 'TBD', capitalization: 25000000 }, { designation: 'TBD' }), false);
});
