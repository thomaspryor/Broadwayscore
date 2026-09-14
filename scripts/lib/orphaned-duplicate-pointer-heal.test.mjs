import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  isTargetInvalidated,
  hasSubstantiveUnflaggedContent,
  shouldClearOrphanedDuplicatePointer,
  findOrphanedDuplicatePointers,
} = require('./orphaned-duplicate-pointer-heal.js');

const REAL_TEXT = 'x'.repeat(600);

function loser(overrides) {
  return { fullText: REAL_TEXT, ...overrides };
}
function target(overrides) {
  return { nonReviewFlag: true, rejectedBy: 'ensemble-scoreability-check', ...overrides };
}

test('isTargetInvalidated: true for wrongShow/wrongProduction/nonReviewFlag/rejectedBy', () => {
  assert.equal(isTargetInvalidated({ wrongShow: true }), true);
  assert.equal(isTargetInvalidated({ wrongProduction: true }), true);
  assert.equal(isTargetInvalidated({ nonReviewFlag: true }), true);
  assert.equal(isTargetInvalidated({ rejectedBy: 'ensemble-scoreability-check' }), true);
  assert.equal(isTargetInvalidated({}), false);
  assert.equal(isTargetInvalidated(null), false);
});

test('isTargetInvalidated: false for other truthy-looking but non-boolean flags', () => {
  assert.equal(isTargetInvalidated({ wrongShow: false }), false);
  assert.equal(isTargetInvalidated({ wrongShow: 'no' }), false);
});

test('hasSubstantiveUnflaggedContent: true for long unflagged fullText', () => {
  assert.equal(hasSubstantiveUnflaggedContent({ fullText: REAL_TEXT }), true);
});

test('hasSubstantiveUnflaggedContent: false for short text', () => {
  assert.equal(hasSubstantiveUnflaggedContent({ fullText: 'too short' }), false);
});

test('hasSubstantiveUnflaggedContent: false when the loser is itself flagged', () => {
  assert.equal(hasSubstantiveUnflaggedContent({ fullText: REAL_TEXT, wrongShow: true }), false);
  assert.equal(hasSubstantiveUnflaggedContent({ fullText: REAL_TEXT, wrongProduction: true }), false);
  assert.equal(hasSubstantiveUnflaggedContent({ fullText: REAL_TEXT, nonReviewFlag: true }), false);
  assert.equal(hasSubstantiveUnflaggedContent({ fullText: REAL_TEXT, contentTier: 'invalid' }), false);
});

test('hasSubstantiveUnflaggedContent: false for missing/non-string fullText', () => {
  assert.equal(hasSubstantiveUnflaggedContent({}), false);
  assert.equal(hasSubstantiveUnflaggedContent(null), false);
});

test('shouldClearOrphanedDuplicatePointer: the moulin-rouge-2019 WSJ case — clears', () => {
  assert.equal(shouldClearOrphanedDuplicatePointer(loser(), target()), true);
});

test('shouldClearOrphanedDuplicatePointer: target not invalidated — does not clear', () => {
  assert.equal(shouldClearOrphanedDuplicatePointer(loser(), { contentTier: 'complete' }), false);
});

test('shouldClearOrphanedDuplicatePointer: loser itself flagged — clean-source gate refuses', () => {
  assert.equal(shouldClearOrphanedDuplicatePointer(loser({ wrongProduction: true }), target()), false);
});

test('shouldClearOrphanedDuplicatePointer: loser too thin — refuses', () => {
  assert.equal(shouldClearOrphanedDuplicatePointer(loser({ fullText: 'stub' }), target()), false);
});

test('shouldClearOrphanedDuplicatePointer: missing loser/target — false', () => {
  assert.equal(shouldClearOrphanedDuplicatePointer(null, target()), false);
  assert.equal(shouldClearOrphanedDuplicatePointer(loser(), null), false);
});

test('findOrphanedDuplicatePointers: moulin-rouge-2019 fixture — finds the wsj pair', () => {
  const records = [
    { file: 'wsj--terry-teachout.json', data: { ...loser(), duplicateOf: 'wsj--unknown.json', _mergeReason: 'same-show-url-dedup' } },
    { file: 'wsj--unknown.json', data: target() },
    { file: 'nyt--jesse-green.json', data: { fullText: REAL_TEXT } },
  ];
  const flips = findOrphanedDuplicatePointers(records);
  assert.deepEqual(flips.map((f) => [f.loserFile, f.targetFile]), [
    ['wsj--terry-teachout.json', 'wsj--unknown.json'],
  ]);
});

test('findOrphanedDuplicatePointers: target still valid — no flips', () => {
  const records = [
    { file: 'a.json', data: { ...loser(), duplicateOf: 'b.json' } },
    { file: 'b.json', data: { fullText: REAL_TEXT } },
  ];
  assert.deepEqual(findOrphanedDuplicatePointers(records), []);
});

test('findOrphanedDuplicatePointers: self-referential duplicateOf is ignored', () => {
  const records = [
    { file: 'a.json', data: { ...loser(), duplicateOf: 'a.json' } },
  ];
  assert.deepEqual(findOrphanedDuplicatePointers(records), []);
});

test('findOrphanedDuplicatePointers: target missing from records — ignored (handled by url-mismatch audit)', () => {
  const records = [
    { file: 'a.json', data: { ...loser(), duplicateOf: 'ghost.json' } },
  ];
  assert.deepEqual(findOrphanedDuplicatePointers(records), []);
});

test('findOrphanedDuplicatePointers: no duplicateOf at all — no flips', () => {
  const records = [
    { file: 'a.json', data: loser() },
    { file: 'b.json', data: target() },
  ];
  assert.deepEqual(findOrphanedDuplicatePointers(records), []);
});
