import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { resolveShowsForDiagnosis, normalizeDiagnosisShowIds } = require('./feedback-multishow.js');

// The real #905 shape: 3 same-titled productions, resolver surfaced all of
// them to the LLM via resolvedShowIds (BRO-4659), diagnosis set ambiguousShow.
const BOOK_OF_MORMON_SHOWS = [
  { id: 'book-of-mormon-bway-2011', title: 'The Book of Mormon', category: 'broadway' },
  { id: 'book-of-mormon-we-2024', title: 'The Book of Mormon', category: 'west-end' },
  { id: 'book-of-mormon-tour-2022', title: 'The Book of Mormon', category: 'tour' },
];

function ambiguousDiagnosis(fixType, overrides = {}) {
  return {
    fixType,
    confidence: 'medium',
    ambiguousShow: true,
    resolvedShowIds: BOOK_OF_MORMON_SHOWS.map((s) => s.id),
    ...overrides,
  };
}

test('resolveShowsForDiagnosis flags ambiguity on a not-a-bug verdict (the #905 shape)', () => {
  // The original #905 bug: the LLM diagnosed "not a bug" BECAUSE it never
  // saw the sibling productions. A gate that only checks ambiguity on the
  // 'data' fixType path never catches this, because the diagnosis that
  // needs catching is exactly the one with fixType === 'not-a-bug'.
  const result = resolveShowsForDiagnosis(ambiguousDiagnosis('not-a-bug'), BOOK_OF_MORMON_SHOWS);
  assert.equal(result.ambiguous, true);
  assert.equal(result.resolvedShows.length, 3);
});

test('resolveShowsForDiagnosis flags ambiguity regardless of fixType', () => {
  for (const fixType of ['data', 'content', 'not-a-bug', 'unknown-fix-type']) {
    const result = resolveShowsForDiagnosis(ambiguousDiagnosis(fixType), BOOK_OF_MORMON_SHOWS);
    assert.equal(result.ambiguous, true, `expected ambiguous=true for fixType=${fixType}`);
  }
});

test('resolveShowsForDiagnosis does not flag ambiguity when only one show resolves', () => {
  const diagnosis = ambiguousDiagnosis('not-a-bug', { resolvedShowIds: [BOOK_OF_MORMON_SHOWS[0].id] });
  const result = resolveShowsForDiagnosis(diagnosis, BOOK_OF_MORMON_SHOWS);
  assert.equal(result.ambiguous, false);
  assert.equal(result.resolvedShows.length, 1);
});

test('resolveShowsForDiagnosis does not flag ambiguity when ambiguousShow is unset, even with multiple showIds', () => {
  // #515 shape: reader's own message genuinely named multiple shows. Not
  // the same thing as one ambiguous title collision — must not be gated.
  const diagnosis = { fixType: 'data', confidence: 'high', showIds: BOOK_OF_MORMON_SHOWS.slice(0, 2).map((s) => s.id) };
  const result = resolveShowsForDiagnosis(diagnosis, BOOK_OF_MORMON_SHOWS);
  assert.equal(result.ambiguous, false);
  assert.equal(result.resolvedShows.length, 2);
});

test('resolveShowsForDiagnosis reports unresolved show IDs separately from resolved ones', () => {
  const diagnosis = { fixType: 'data', confidence: 'high', showIds: ['book-of-mormon-bway-2011', 'does-not-exist'] };
  const result = resolveShowsForDiagnosis(diagnosis, BOOK_OF_MORMON_SHOWS);
  assert.equal(result.ambiguous, false);
  assert.deepEqual(result.unresolvedShowIds, ['does-not-exist']);
  assert.equal(result.resolvedShows.length, 1);
});

test('resolveShowsForDiagnosis returns empty showIds/resolvedShows when the diagnosis names no show', () => {
  const result = resolveShowsForDiagnosis({ fixType: 'not-a-bug', confidence: 'high' }, BOOK_OF_MORMON_SHOWS);
  assert.deepEqual(result.showIds, []);
  assert.deepEqual(result.resolvedShows, []);
  assert.equal(result.ambiguous, false);
});

test('resolveShowsForDiagnosis composes with normalizeDiagnosisShowIds (same showIds list)', () => {
  const diagnosis = ambiguousDiagnosis('not-a-bug');
  const result = resolveShowsForDiagnosis(diagnosis, BOOK_OF_MORMON_SHOWS);
  assert.deepEqual(result.showIds, normalizeDiagnosisShowIds(diagnosis));
});
