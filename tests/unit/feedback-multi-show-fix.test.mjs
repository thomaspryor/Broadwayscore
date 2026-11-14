// Regression test for issue #515 / BRO-130: a feedback report naming TWO
// shows with the same bug used to resolve only one showId, so the second
// show was silently dropped from relevantFiles and the auto-fix issue closed
// as COMPLETED having fixed only one of the two shows named.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  normalizeDiagnosisShowIds,
  summarizeShowFixOutcomes,
} = require('../../scripts/lib/feedback-multishow.js');

describe('normalizeDiagnosisShowIds', () => {
  test('prefers an existing showIds[] array', () => {
    const ids = normalizeDiagnosisShowIds({
      showIds: ['a', 'b'],
      resolvedShowIds: ['c'],
      showId: 'd',
    });
    assert.deepEqual(ids, ['a', 'b']);
  });

  test('falls back to resolvedShowIds when showIds is absent', () => {
    const ids = normalizeDiagnosisShowIds({
      resolvedShowIds: ['3-summers-of-lincoln-regional-2025', 'the-family-album-off-broadway-2026'],
      showId: '3-summers-of-lincoln-regional-2025',
    });
    assert.deepEqual(ids, [
      '3-summers-of-lincoln-regional-2025',
      'the-family-album-off-broadway-2026',
    ]);
  });

  test('falls back to the legacy singular showId when no array is present', () => {
    const ids = normalizeDiagnosisShowIds({ showId: 'hamilton-2015' });
    assert.deepEqual(ids, ['hamilton-2015']);
  });

  test('returns an empty array when nothing resolved', () => {
    assert.deepEqual(normalizeDiagnosisShowIds({}), []);
    assert.deepEqual(normalizeDiagnosisShowIds({ showIds: [] }), []);
  });

  test('dedupes and drops falsy entries', () => {
    const ids = normalizeDiagnosisShowIds({ showIds: ['a', 'a', null, 'b', undefined] });
    assert.deepEqual(ids, ['a', 'b']);
  });
});

describe('summarizeShowFixOutcomes', () => {
  // Fixture mirrors the real bug: "3 Summers of Lincoln" + "The Family
  // Album" both reported with the same wrong-venue-city error.
  const lincoln = { id: '3-summers-of-lincoln-regional-2025', title: '3 Summers of Lincoln' };
  const familyAlbum = { id: 'the-family-album-off-broadway-2026', title: 'The Family Album' };

  test('both shows fixed => action fixed, issue can close', () => {
    const { action, comment } = summarizeShowFixOutcomes([
      { show: lincoln, applied: ['shows.json: venue = "..."'] },
      { show: familyAlbum, applied: ['shows.json: venue = "..."'] },
    ]);
    assert.equal(action, 'fixed');
    assert.match(comment, /Fix Applied/);
    assert.match(comment, /3 Summers of Lincoln/);
    assert.match(comment, /The Family Album/);
  });

  test('only ONE of two shows fixed => action partial, NOT fixed (issue #515 regression)', () => {
    const { action, comment } = summarizeShowFixOutcomes([
      { show: lincoln, applied: ['shows.json: venue = "..."'] },
      { show: familyAlbum, applied: [], skipped: ['no changes identified'] },
    ]);
    assert.equal(action, 'partial');
    assert.notEqual(action, 'fixed'); // the exact bug: this used to be reported 'fixed'
    assert.match(comment, /Partially Fixed/);
    assert.match(comment, /3 Summers of Lincoln.*Fixed/s);
    assert.match(comment, /The Family Album.*Not fixed/s);
  });

  test('a show unresolved in shows.json also blocks the fixed verdict', () => {
    const { action, comment } = summarizeShowFixOutcomes(
      [{ show: lincoln, applied: ['shows.json: venue = "..."'] }],
      ['ghost-show-id'],
    );
    assert.equal(action, 'partial');
    assert.match(comment, /ghost-show-id.*Not fixed \(show not found in shows\.json\)/s);
  });

  test('no shows fixed at all => action skipped, not partial or fixed', () => {
    const { action, comment } = summarizeShowFixOutcomes([
      { show: lincoln, applied: [], error: 'could not determine the correct edit' },
      { show: familyAlbum, applied: [], error: 'could not determine the correct edit' },
    ]);
    assert.equal(action, 'skipped');
    assert.match(comment, /Requires Manual Review/);
  });

  test('single-show report still resolves to fixed exactly as before', () => {
    const { action } = summarizeShowFixOutcomes([
      { show: lincoln, applied: ['shows.json: venue = "..."'] },
    ]);
    assert.equal(action, 'fixed');
  });
});

describe('end-to-end: two-show report produces a non-silent partial outcome', () => {
  test('diagnosis carrying resolvedShowIds for both shows, only one fixable, never reports fixed', () => {
    const diagnosis = {
      summary: 'Wrong venue city for two regional productions',
      resolvedShowIds: [
        '3-summers-of-lincoln-regional-2025',
        'the-family-album-off-broadway-2026',
      ],
    };

    const showIds = normalizeDiagnosisShowIds(diagnosis);
    assert.equal(showIds.length, 2, 'both shows referenced in the report must be carried through');

    // Simulate the auto-fix executor: show 1 gets fixed, show 2 (per the
    // real incident) has no clean fix available this pass.
    const perShowResults = [
      { show: { id: showIds[0], title: '3 Summers of Lincoln' }, applied: ['shows.json: venue = "Lincoln, NE"'] },
      { show: { id: showIds[1], title: 'The Family Album' }, applied: [], error: 'could not determine the correct edit' },
    ];

    const { action } = summarizeShowFixOutcomes(perShowResults);
    assert.equal(action, 'partial', 'must not silently report fixed when only one of two shows was resolved');
  });
});
