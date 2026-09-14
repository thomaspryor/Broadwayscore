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
  parseHealClearPriorReason,
  wouldCloseDuplicateCycle,
  findChainPointersThrough,
  HEAL_CLEAR_BREADCRUMB_PREFIX,
  findOrphanedDuplicateTextPointers,
  buildDuplicateTextClearReason,
  partitionOrphansForFix,
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

test('wouldCloseDuplicateCycle: direct, transitive, and clean chains', () => {
  const byFile = new Map([
    ['a.json', { duplicateOf: null }],
    ['b.json', { duplicateOf: 'a.json' }],      // b → a
    ['c.json', { duplicateOf: 'b.json' }],      // c → b → a
    ['d.json', { duplicateOf: null }],
  ]);
  assert.equal(wouldCloseDuplicateCycle('a.json', 'b.json', byFile), true);  // a → b → a
  assert.equal(wouldCloseDuplicateCycle('a.json', 'c.json', byFile), true);  // a → c → b → a
  assert.equal(wouldCloseDuplicateCycle('a.json', 'd.json', byFile), false);
  // A loop that does NOT include the loser still terminates rather than hanging.
  const looped = new Map([['x.json', { duplicateOf: 'y.json' }], ['y.json', { duplicateOf: 'x.json' }]]);
  assert.equal(wouldCloseDuplicateCycle('z.json', 'x.json', looped), true);
});

test('buildHealClearReason: records the duplicateReason it nulls, and old breadcrumbs still parse', () => {
  const withPrior = buildHealClearReason('2026-09-14', 'b.json', 'r', 'byline-explosion-collapse');
  assert.equal(parseHealClearTarget(withPrior), 'b.json');
  assert.equal(parseHealClearPriorReason(withPrior), 'byline-explosion-collapse');
  // Pre-suffix breadcrumb (127 of these already on disk) — target still parses, prior reason is unknown.
  const legacy = buildHealClearReason('2026-09-14', 'b.json', 'r');
  assert.equal(parseHealClearTarget(legacy), 'b.json');
  assert.equal(parseHealClearPriorReason(legacy), null);
});

test('findUnjustifiedHealClears: carries the prior duplicateReason through for restore', () => {
  const records = [
    { file: 'a.json', data: { ...loser(), url: DUP_URL, duplicateClearReason: buildHealClearReason('2026-09-14', 'b.json', 'r', 'criticName-override-collided-at-rename') } },
    { file: 'b.json', data: { fullText: REAL_TEXT, url: DUP_URL, wrongProduction: true, wrongProductionManualClear: true } },
  ];
  assert.equal(findUnjustifiedHealClears(records)[0].priorDuplicateReason, 'criticName-override-collided-at-rename');
});

test('findUnjustifiedHealClears: honors _duplicateOfCleared — never re-suppresses a human-verified same-URL pair', () => {
  const records = [
    {
      file: 'a.json',
      data: {
        ...loser(),
        url: DUP_URL,
        _duplicateOfCleared: 'auto:2026-04-12 different critics (matt windman vs ben brantley)',
        duplicateClearReason: buildHealClearReason('2026-09-14', 'b.json', 'r'),
      },
    },
    { file: 'b.json', data: { fullText: REAL_TEXT, url: DUP_URL, wrongProduction: true, wrongProductionManualClear: true } },
  ];
  assert.deepEqual(findUnjustifiedHealClears(records), []);
});

test('findUnjustifiedHealClears: refuses to bury a substantive body under a near-empty sibling', () => {
  const records = [
    { file: 'a.json', data: { fullText: 'x'.repeat(4000), url: DUP_URL, duplicateClearReason: buildHealClearReason('2026-09-14', 'b.json', 'r') } },
    { file: 'b.json', data: { fullText: 'stub', url: DUP_URL, wrongProduction: true, wrongProductionManualClear: true } },
  ];
  assert.deepEqual(findUnjustifiedHealClears(records), []);
});

test('findChainPointersThrough: re-aims the sibling that pointed at a re-suppressed loser', () => {
  // romeo-juliet-2024: jackson-mchenry → helen-shaw → sara-holdren. Once
  // helen-shaw is a duplicate again, jackson-mchenry must point at sara-holdren
  // directly or rebuild-all-reviews.js recovers it into reviews.json.
  const records = [
    { file: 'vulture--jackson-mchenry.json', data: { fullText: REAL_TEXT, url: DUP_URL, duplicateOf: 'vulture--helen-shaw.json', duplicateTextOf: 'vulture--helen-shaw.json' } },
    { file: 'vulture--helen-shaw.json', data: { fullText: REAL_TEXT, url: DUP_URL, duplicateOf: 'vulture--sara-holdren.json' } },
    { file: 'vulture--sara-holdren.json', data: { fullText: REAL_TEXT, url: DUP_URL } },
  ];
  assert.deepEqual(findChainPointersThrough(records, 'vulture--helen-shaw.json').map((c) => [c.loserFile, c.targetFile]), [
    ['vulture--jackson-mchenry.json', 'vulture--sara-holdren.json'],
  ]);
});

test('findChainPointersThrough: nothing to flatten when the loser is already canonical', () => {
  const records = [
    { file: 'a.json', data: { fullText: REAL_TEXT, url: DUP_URL, duplicateOf: 'b.json' } },
    { file: 'b.json', data: { fullText: REAL_TEXT, url: DUP_URL } },
  ];
  assert.deepEqual(findChainPointersThrough(records, 'b.json'), []);
});

test('findChainPointersThrough: skips a sibling whose URL differs from the canonical', () => {
  const records = [
    { file: 'a.json', data: { fullText: REAL_TEXT, url: 'https://example.com/other', duplicateOf: 'b.json' } },
    { file: 'b.json', data: { fullText: REAL_TEXT, url: DUP_URL, duplicateOf: 'c.json' } },
    { file: 'c.json', data: { fullText: REAL_TEXT, url: DUP_URL } },
  ];
  assert.deepEqual(findChainPointersThrough(records, 'b.json'), []);
});

test('findUnjustifiedHealClears: refuses to restore a pointer that would close a cycle', () => {
  const records = [
    { file: 'a.json', data: { ...loser(), url: DUP_URL, duplicateClearReason: buildHealClearReason('2026-09-14', 'b.json', 'r') } },
    // b already points back at a — restoring a → b would exclude both from the rebuild.
    { file: 'b.json', data: { fullText: REAL_TEXT, url: DUP_URL, duplicateOf: 'a.json' } },
  ];
  assert.deepEqual(findUnjustifiedHealClears(records), []);
});

// --- findOrphanedDuplicateTextPointers (BRO-3336: the duplicateTextOf cousin) ---

test('findOrphanedDuplicateTextPointers: 1536-west-end-2026 shaped fixture — finds the pair', () => {
  const records = [
    { file: 'broadwayworld--debbie-gilpin.json', data: { ...loser(), duplicateTextOf: 'broadwayworld--cindy-marcolina.json' } },
    { file: 'broadwayworld--cindy-marcolina.json', data: target() },
    { file: 'nyt--jesse-green.json', data: { fullText: REAL_TEXT } },
  ];
  const flips = findOrphanedDuplicateTextPointers(records);
  assert.deepEqual(flips.map((f) => [f.loserFile, f.targetFile]), [
    ['broadwayworld--debbie-gilpin.json', 'broadwayworld--cindy-marcolina.json'],
  ]);
});

test('findOrphanedDuplicateTextPointers: target still valid — no flips', () => {
  const records = [
    { file: 'a.json', data: { ...loser(), duplicateTextOf: 'b.json' } },
    { file: 'b.json', data: { fullText: REAL_TEXT } },
  ];
  assert.deepEqual(findOrphanedDuplicateTextPointers(records), []);
});

test('findOrphanedDuplicateTextPointers: self-referential duplicateTextOf is ignored', () => {
  const records = [
    { file: 'a.json', data: { ...loser(), duplicateTextOf: 'a.json' } },
  ];
  assert.deepEqual(findOrphanedDuplicateTextPointers(records), []);
});

test('findOrphanedDuplicateTextPointers: target missing from records — ignored', () => {
  const records = [
    { file: 'a.json', data: { ...loser(), duplicateTextOf: 'ghost.json' } },
  ];
  assert.deepEqual(findOrphanedDuplicateTextPointers(records), []);
});

test('findOrphanedDuplicateTextPointers: no duplicateTextOf at all — no flips', () => {
  const records = [
    { file: 'a.json', data: loser() },
    { file: 'b.json', data: target() },
  ];
  assert.deepEqual(findOrphanedDuplicateTextPointers(records), []);
});

test('findOrphanedDuplicateTextPointers: loser itself flagged — clean-source gate refuses (shared with duplicateOf)', () => {
  const records = [
    { file: 'a.json', data: { ...loser({ wrongProduction: true }), duplicateTextOf: 'b.json' } },
    { file: 'b.json', data: target() },
  ];
  assert.deepEqual(findOrphanedDuplicateTextPointers(records), []);
});

test('findOrphanedDuplicateTextPointers: duplicateOf on the same record is untouched — fields are independent', () => {
  const records = [
    { file: 'a.json', data: { ...loser(), duplicateOf: 'c.json', duplicateTextOf: 'b.json' } },
    { file: 'b.json', data: target() },
    { file: 'c.json', data: { fullText: REAL_TEXT } },
  ];
  const textFlips = findOrphanedDuplicateTextPointers(records);
  assert.deepEqual(textFlips.map((f) => [f.loserFile, f.targetFile]), [['a.json', 'b.json']]);
  assert.deepEqual(findOrphanedDuplicatePointers(records), []);
});

test('findOrphanedDuplicateTextPointers: honors BRO-3092 retraction-aware isTargetInvalidated', () => {
  // Target's wrongProduction was already retracted by an operator — the shared
  // predicate must decline, exactly as it does for duplicateOf.
  const records = [
    { file: 'a.json', data: { ...loser(), duplicateTextOf: 'b.json' } },
    { file: 'b.json', data: { fullText: REAL_TEXT, wrongProduction: true, wrongProductionManualClear: true } },
  ];
  assert.deepEqual(findOrphanedDuplicateTextPointers(records), []);
});

// --- buildDuplicateTextClearReason (BRO-3336: must not cross-talk with duplicateOf's revert parser) ---

test('buildDuplicateTextClearReason: does not match parseHealClearTarget (no cross-talk with --revert-unjustified)', () => {
  const reason = buildDuplicateTextClearReason('2026-09-14', 'broadwayworld--cindy-marcolina.json', 'orphaned-duplicate-heal: ... (duplicateTextOf)');
  assert.equal(parseHealClearTarget(reason), null);
  assert.ok(!reason.startsWith(HEAL_CLEAR_BREADCRUMB_PREFIX));
  assert.match(reason, /target broadwayworld--cindy-marcolina\.json was flagged invalid/);
});

// --- partitionOrphansForFix (BRO-3336: surge guard checked per field, not combined) ---

function orphan(field, n) {
  return Array.from({ length: n }, (_, i) => ({ loserFile: `${field}-${i}.json`, targetFile: 'x.json', field }));
}

test('partitionOrphansForFix: both fields under threshold — all fixable, nothing surging', () => {
  const orphans = [...orphan('duplicateOf', 5), ...orphan('duplicateTextOf', 5)];
  const { fixable, surgingFields } = partitionOrphansForFix(orphans, 10, false);
  assert.equal(fixable.length, 10);
  assert.deepEqual(surgingFields, []);
});

test('partitionOrphansForFix: one field over threshold — only the OTHER field is fixable', () => {
  const orphans = [...orphan('duplicateOf', 20), ...orphan('duplicateTextOf', 5)];
  const { fixable, surgingFields } = partitionOrphansForFix(orphans, 10, false);
  assert.equal(fixable.length, 5);
  assert.ok(fixable.every((o) => o.field === 'duplicateTextOf'));
  assert.deepEqual(surgingFields, [{ field: 'duplicateOf', count: 20 }]);
});

test('partitionOrphansForFix: both fields over threshold — nothing fixable, both reported surging', () => {
  const orphans = [...orphan('duplicateOf', 20), ...orphan('duplicateTextOf', 15)];
  const { fixable, surgingFields } = partitionOrphansForFix(orphans, 10, false);
  assert.equal(fixable.length, 0);
  assert.deepEqual(
    surgingFields.sort((a, b) => a.field.localeCompare(b.field)),
    [{ field: 'duplicateOf', count: 20 }, { field: 'duplicateTextOf', count: 15 }],
  );
});

test('partitionOrphansForFix: exactly at threshold is fixable, one over is not', () => {
  const orphans = orphan('duplicateOf', 10);
  assert.equal(partitionOrphansForFix(orphans, 10, false).fixable.length, 10);
  assert.equal(partitionOrphansForFix([...orphans, orphan('duplicateOf', 1)[0]], 10, false).fixable.length, 0);
});

test('partitionOrphansForFix: force=true bypasses the guard entirely, even when surging', () => {
  const orphans = [...orphan('duplicateOf', 20), ...orphan('duplicateTextOf', 15)];
  const { fixable, surgingFields } = partitionOrphansForFix(orphans, 10, true);
  assert.equal(fixable.length, 35);
  assert.deepEqual(surgingFields, []);
});

test('partitionOrphansForFix: empty input — nothing fixable, nothing surging', () => {
  assert.deepEqual(partitionOrphansForFix([], 10, false), { fixable: [], surgingFields: [] });
  assert.deepEqual(partitionOrphansForFix(undefined, 10, false), { fixable: [], surgingFields: [] });
});
