import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  isTargetInvalidated,
  hasSubstantiveUnflaggedContent,
  shouldClearOrphanedDuplicatePointer,
  findOrphanedDuplicatePointers,
  findUnjustifiedHealClears,
  buildHealClearReason,
  parseHealClearTarget,
  HEAL_CLEAR_BREADCRUMB_PREFIX,
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

// ── BRO-3092: a retracted wrongProduction/wrongShow flag is not "invalidated" ──
//
// The 2026-09-14 --force-bulk run cleared 6 pointers whose target carried a raw
// wrongProduction:true that an operator (or an auto-clear pass) had already
// retracted. classifyContentTier keeps those records INCLUDED, so the clear
// re-admitted a second copy of an already-canonical URL and turned
// validate-data.js red on romeo-juliet-2024 (Vulture, Helen Shaw vs Sara Holdren).

test('isTargetInvalidated: wrongProduction retracted by a manual clear is NOT invalidated', () => {
  assert.equal(isTargetInvalidated({ wrongProduction: true, wrongProductionManualClear: true }), false);
  assert.equal(isTargetInvalidated({ wrongProduction: true, wrongProductionAutoCleared: true }), false);
  assert.equal(isTargetInvalidated({ wrongProduction: true, wrongProductionCleared: true }), false);
  assert.equal(isTargetInvalidated({ wrongProduction: true, allowEarlyDate: true }), false);
  assert.equal(isTargetInvalidated({ wrongProduction: true, allowCrossMarket: true }), false);
  assert.equal(isTargetInvalidated({ wrongProduction: true, humanReviewedWrongProduction: false }), false);
  assert.equal(isTargetInvalidated({ wrongShow: true, wrongShowManualClear: true }), false);
});

test('isTargetInvalidated: an UNretracted flag still invalidates', () => {
  assert.equal(isTargetInvalidated({ wrongProduction: true }), true);
  assert.equal(isTargetInvalidated({ wrongShow: true }), true);
  // nonReviewFlag / rejectedBy have no clear-breadcrumb concept — unchanged.
  assert.equal(isTargetInvalidated({ wrongProduction: true, wrongProductionManualClear: true, nonReviewFlag: true }), true);
  assert.equal(isTargetInvalidated({ wrongShow: true, wrongShowManualClear: true, rejectedBy: 'ensemble-scoreability-check' }), true);
});

test('hasSubstantiveUnflaggedContent: stays strict — a retracted flag still fails the clean-source gate', () => {
  // The BRO-3092 fix narrows isTargetInvalidated ONLY. Softening the loser-side
  // gate would widen what the heal clears, which is the wrong direction.
  assert.equal(hasSubstantiveUnflaggedContent({ fullText: REAL_TEXT, wrongProduction: true, wrongProductionManualClear: true }), false);
  assert.equal(hasSubstantiveUnflaggedContent({ fullText: REAL_TEXT, wrongShow: true, wrongShowManualClear: true }), false);
});

test('findOrphanedDuplicatePointers: romeo-juliet-2024 Vulture — manually-cleared target is left alone', () => {
  const records = [
    { file: 'vulture--helen-shaw.json', data: { ...loser(), duplicateOf: 'vulture--sara-holdren.json' } },
    { file: 'vulture--sara-holdren.json', data: { fullText: REAL_TEXT, wrongProduction: true, wrongProductionManualClear: true } },
  ];
  assert.deepEqual(findOrphanedDuplicatePointers(records), []);
});

// ── BRO-3092 retraction pass ───────────────────────────────────────────────

const DUP_URL = 'https://www.vulture.com/article/theater-review-connor-zegler-gold-romeo-juliet.html';

test('buildHealClearReason / parseHealClearTarget round-trip', () => {
  const reason = buildHealClearReason('2026-09-14', 'vulture--sara-holdren.json', 'orphaned-duplicate-heal: x');
  assert.equal(parseHealClearTarget(reason), 'vulture--sara-holdren.json');
});

test('parseHealClearTarget: ignores breadcrumbs written by other clearers', () => {
  assert.equal(parseHealClearTarget('auto-cleared at write: sibling b.json no longer exists'), null);
  assert.equal(parseHealClearTarget(null), null);
  assert.equal(parseHealClearTarget(''), null);
  assert.equal(parseHealClearTarget(`${HEAL_CLEAR_BREADCRUMB_PREFIX}2026-09-14: something else entirely`), null);
});

test('findUnjustifiedHealClears: the romeo-juliet-2024 Vulture pair — restores', () => {
  const records = [
    {
      file: 'vulture--helen-shaw.json',
      data: {
        ...loser(),
        url: `${DUP_URL}#:~:text=It%27s%20very%20nice.`,
        duplicateOf: null,
        duplicateClearReason: buildHealClearReason('2026-09-14', 'vulture--sara-holdren.json', 'orphaned-duplicate-heal: x'),
      },
    },
    {
      file: 'vulture--sara-holdren.json',
      data: { fullText: REAL_TEXT, url: DUP_URL, wrongProduction: true, wrongProductionManualClear: true },
    },
  ];
  assert.deepEqual(findUnjustifiedHealClears(records).map((o) => [o.loserFile, o.targetFile]), [
    ['vulture--helen-shaw.json', 'vulture--sara-holdren.json'],
  ]);
});

test('findUnjustifiedHealClears: target genuinely invalid — clear stands', () => {
  const records = [
    { file: 'a.json', data: { ...loser(), url: DUP_URL, duplicateClearReason: buildHealClearReason('2026-09-14', 'b.json', 'r') } },
    { file: 'b.json', data: { fullText: REAL_TEXT, url: DUP_URL, nonReviewFlag: true } },
  ];
  assert.deepEqual(findUnjustifiedHealClears(records), []);
});

test('findUnjustifiedHealClears: URLs no longer match — collision basis gone, clear stands', () => {
  const records = [
    { file: 'a.json', data: { ...loser(), url: 'https://www.vulture.com/article/a-completely-different-piece.html', duplicateClearReason: buildHealClearReason('2026-09-14', 'b.json', 'r') } },
    { file: 'b.json', data: { fullText: REAL_TEXT, url: DUP_URL, wrongProduction: true, wrongProductionManualClear: true } },
  ];
  assert.deepEqual(findUnjustifiedHealClears(records), []);
});

test('findUnjustifiedHealClears: the operation-mincemeat-2025 Time Out pair — a bare www difference is still the same URL', () => {
  // Canonical collision normalization (review-normalization.normalizeUrl), not
  // validate-data.js's fragment-only gate: these two ARE colliding, so the
  // pointer must come back even though the duplicate-URL error never fired.
  const records = [
    {
      file: 'timeout--unknown.json',
      data: {
        ...loser(),
        url: 'https://timeout.com/newyork/theater/operation-mincemeat-musical-broadway-review',
        duplicateClearReason: buildHealClearReason('2026-09-14', 'timeout--adam-feldman.json', 'r'),
      },
    },
    {
      file: 'timeout--adam-feldman.json',
      data: {
        fullText: REAL_TEXT,
        url: 'https://www.timeout.com/newyork/theater/operation-mincemeat-musical-broadway-review',
        wrongProduction: true,
        allowEarlyDate: true,
      },
    },
  ];
  assert.deepEqual(findUnjustifiedHealClears(records).map((o) => [o.loserFile, o.targetFile]), [
    ['timeout--unknown.json', 'timeout--adam-feldman.json'],
  ]);
});

test('findUnjustifiedHealClears: pointer already live again — nothing to restore', () => {
  const records = [
    { file: 'a.json', data: { ...loser(), url: DUP_URL, duplicateOf: 'b.json', duplicateClearReason: buildHealClearReason('2026-09-14', 'b.json', 'r') } },
    { file: 'b.json', data: { fullText: REAL_TEXT, url: DUP_URL, wrongProduction: true, wrongProductionManualClear: true } },
  ];
  assert.deepEqual(findUnjustifiedHealClears(records), []);
});

test('findUnjustifiedHealClears: never touches another clearer’s breadcrumb', () => {
  const records = [
    { file: 'a.json', data: { ...loser(), url: DUP_URL, duplicateClearReason: 'manual: operator un-suppressed 2026-05-01' } },
    { file: 'b.json', data: { fullText: REAL_TEXT, url: DUP_URL } },
  ];
  assert.deepEqual(findUnjustifiedHealClears(records), []);
});

test('findUnjustifiedHealClears: target missing from the directory — clear stands', () => {
  const records = [
    { file: 'a.json', data: { ...loser(), url: DUP_URL, duplicateClearReason: buildHealClearReason('2026-09-14', 'ghost.json', 'r') } },
  ];
  assert.deepEqual(findUnjustifiedHealClears(records), []);
});
