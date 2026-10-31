import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findDuplicateOpenBug } = require('../../scripts/lib/feedback-dedup.js');

const a = '3-summers-of-lincoln-regional-2025';
const b = 'the-family-album-regional-2026';
const c = 'hamilton-2015';
const summary = 'Venue city incorrectly listed for La Jolla Playhouse production';
const diagnosis = (fields = {}) => ({ summary, ...fields });
const match = (incoming, existing) => findDuplicateOpenBug(incoming, [{ number: 515, diagnosis: existing }]);

for (const field of ['showIds', 'resolvedShowIds']) {
  test(`${field}: matches reordered multi-show reports with different primary shows`, () => {
    const existing = diagnosis({ showId: a, [field]: [a, b] });
    const result = match(diagnosis({ showId: b, [field]: [b, a] }), existing);
    assert.equal(result?.number, 515);
    assert.equal(result?.diagnosis, existing);
  });

  test(`${field}: matches a legacy single-show repeat of the secondary show`, () => {
    const result = match(diagnosis({ showId: b }), diagnosis({ showId: a, [field]: [a, b] }));
    assert.equal(result?.number, 515);
    assert.ok(result.reason.includes(b));
  });

  test(`${field}: disjoint array-only reports are not show-agnostic`, () => {
    assert.equal(match(diagnosis({ [field]: [c] }), diagnosis({ [field]: [a, b] })), null);
  });

  test(`${field}: keeps reports that add an affected show for a new auto-fix`, () => {
    assert.equal(match(diagnosis({ showId: a, [field]: [a, b] }), diagnosis({ showId: a })), null);
    assert.equal(match(diagnosis({ [field]: [a, c] }), diagnosis({ [field]: [a, b] })), null);
  });
}

test('matches resolvedShowIds before payload building against canonical showIds', () => {
  assert.equal(match(diagnosis({ resolvedShowIds: [b] }), diagnosis({ showIds: [a, b] }))?.number, 515);
});

test('normalizes duplicate and empty IDs with the existing canonical field precedence', () => {
  assert.equal(match(diagnosis({ showIds: [b, b, null], resolvedShowIds: [c], showId: c }), diagnosis({ showIds: [a, b] }))?.number, 515);
  assert.equal(match(diagnosis({ showIds: [], resolvedShowIds: [b] }), diagnosis({ showId: b }))?.number, 515);
  assert.equal(match(diagnosis({ showIds: [], resolvedShowIds: [], showId: b }), diagnosis({ showId: b }))?.number, 515);
});

test('show-scoped and show-agnostic reports stay separate in both directions', () => {
  assert.equal(match(diagnosis({ showIds: [a, b] }), diagnosis()), null);
  assert.equal(match(diagnosis(), diagnosis({ resolvedShowIds: [a, b] })), null);
  assert.equal(match(diagnosis({ showIds: [null] }), diagnosis({ resolvedShowIds: [null] }))?.number, 515);
});

test('shared shows still require topic similarity and at least two shared tokens', () => {
  assert.equal(match(diagnosis({ showIds: [b], summary: 'Ticket checkout keyboard navigation inaccessible' }), diagnosis({ showIds: [a, b] })), null);
  assert.equal(match(diagnosis({ showIds: [b], summary: 'Homepage buttons' }), diagnosis({ showIds: [a, b], summary: 'Homepage layout' })), null);
});

test('selects the highest-similarity covering issue and preserves threshold options', () => {
  const incoming = diagnosis({ showIds: [b] });
  const existing = diagnosis({ showIds: [a, b] });
  const openBugs = [
    { number: 1, diagnosis: diagnosis({ showIds: [a, b], summary: 'Venue city' }) },
    { number: 515, diagnosis: existing },
  ];
  assert.equal(findDuplicateOpenBug(incoming, openBugs)?.number, 515);
  assert.equal(findDuplicateOpenBug(incoming, openBugs, { showMatchThreshold: 1.1 }), null);
  assert.equal(findDuplicateOpenBug(incoming, openBugs, { minSharedTokens: 100 }), null);
});
