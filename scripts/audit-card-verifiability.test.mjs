import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  evaluateCard, buildReport, evaluateLinearIssue, attachMissingCheckPaths,
  reconcileMissingCheckPathsWithComments,
  reconcileVacuousChecksWithComments,
  reconcileCheckDefectsBothBuckets,
} = require('./audit-card-verifiability.js');

test('evaluateCard: armed card carries no reason', () => {
  const card = {
    id: 'aaa', name: 'Fix the thing', url: 'https://notion/aaa', priority: 'P1 Next',
    status: 'Not started', category: 'Product', tags: [],
    notes: '## Acceptance criteria\n- `npx tsc --noEmit` passes',
  };
  const r = evaluateCard(card);
  assert.equal(r.armed, true);
  assert.equal(r.reason, null);
  assert.equal(r.ownerJudgment, false);
});

test('evaluateCard: prose-only card is refused with a reason', () => {
  const card = {
    id: 'bbb', name: 'Improve onboarding', url: 'https://notion/bbb', priority: 'P2 Later',
    status: 'Not started', category: 'Product', tags: [],
    notes: '## Acceptance criteria\nThe flow feels smoother.',
  };
  const r = evaluateCard(card);
  assert.equal(r.armed, false);
  assert.match(r.reason, /names no runnable command/);
});

test('evaluateCard: VERIFY: owner-judgment is armed with no command', () => {
  const card = {
    id: 'ccc', name: 'Email Sarah about growth plan', url: 'https://notion/ccc', priority: 'P2 Later',
    status: 'Not started', category: 'Marketing', tags: [],
    notes: '## Problem\nCatch up with Sarah.\n\nVERIFY: owner-judgment',
  };
  const r = evaluateCard(card);
  assert.equal(r.armed, true);
  assert.equal(r.ownerJudgment, true);
});

test('buildReport: counts armed vs refused and lists only refused cards', () => {
  const now = new Date('2026-07-30T12:00:00Z');
  const evaluated = [
    { id: 'a', name: 'A', priority: 'P0 Now', url: 'u-a', armed: true, reason: null },
    { id: 'b', name: 'B', priority: 'P1 Next', url: 'u-b', armed: false, reason: 'names no runnable command (prose only)' },
    { id: 'c', name: 'C', priority: 'P2 Later', url: 'u-c', armed: false, reason: 'no acceptance-criteria section or VERIFY line' },
  ];
  const report = buildReport(evaluated, now);
  assert.equal(report.total, 3);
  assert.equal(report.armedCount, 1);
  assert.equal(report.refusedCount, 2);
  assert.equal(report.refused.length, 2);
  assert.deepEqual(report.refused.map(r => r.id), ['b', 'c']);
  assert.equal(report.generatedAt, now.toISOString());
});

// BRO-3866 ship-check (Codex adversarial finding): this report is
// data/audit/card-verifiability.json, committed to the PUBLIC repo, and a
// card title can be pasted straight from an email subject line.
test('buildReport: redacts an email-shaped card name before it lands in the committed report', () => {
  const evaluated = [
    { id: 'a', name: 'Re: bug report from jane@example.com', priority: 'P1 Next', url: 'u-a', armed: false, reason: 'prose only' },
  ];
  const report = buildReport(evaluated);
  assert.equal(report.refused[0].name.includes('jane@example.com'), false);
});

test('buildReport: zero cards produces a zeroed report, not a crash', () => {
  const report = buildReport([]);
  assert.equal(report.total, 0);
  assert.equal(report.armedCount, 0);
  assert.equal(report.refusedCount, 0);
  assert.deepEqual(report.refused, []);
});

// ── Linear leg (task #1830) ─────────────────────────────────────────────────

test('evaluateLinearIssue: armed issue carries no reason', () => {
  const issue = {
    identifier: 'BRO-1', title: 'Fix the thing', url: 'https://linear/BRO-1',
    description: '## Acceptance criteria\n- `npx tsc --noEmit` passes',
    state: { name: 'Todo', type: 'unstarted' },
  };
  const r = evaluateLinearIssue(issue);
  assert.equal(r.id, 'BRO-1');
  assert.equal(r.name, 'Fix the thing');
  assert.equal(r.armed, true);
  assert.equal(r.reason, null);
  assert.equal(r.ownerJudgment, false);
});

test('evaluateLinearIssue: prose-only description is refused with a reason', () => {
  const issue = {
    identifier: 'BRO-2', title: 'Improve onboarding', url: 'https://linear/BRO-2',
    description: '## Acceptance criteria\nThe flow feels smoother.',
  };
  const r = evaluateLinearIssue(issue);
  assert.equal(r.armed, false);
  assert.match(r.reason, /names no runnable command/);
});

test('evaluateLinearIssue: VERIFY: owner-judgment is armed with no command', () => {
  const issue = {
    identifier: 'BRO-3', title: 'Email Sarah about growth plan', url: 'https://linear/BRO-3',
    description: '## Problem\nCatch up with Sarah.\n\nVERIFY: owner-judgment',
  };
  const r = evaluateLinearIssue(issue);
  assert.equal(r.armed, true);
  assert.equal(r.ownerJudgment, true);
});

test('evaluateLinearIssue: missing description is refused, not a crash', () => {
  const r = evaluateLinearIssue({ identifier: 'BRO-4', title: 'No description' });
  assert.equal(r.armed, false);
});

// ── BRO-2977/BRO-3076: missing-check-path wiring ────────────────────────────

test('reconcileMissingCheckPathsWithComments: a VERIFY comment naming a real file clears the flag (BRO-2796 correction path)', async () => {
  const flagged = [{
    id: 'BRO-1', name: 'Phantom path', url: 'u1',
    cmd: 'node --test tests/unit/phantom.test.mjs', missingPaths: ['tests/unit/phantom.test.mjs'],
  }];
  const getIssue = async (id) => ({
    identifier: id,
    description: '## Acceptance criteria\n`node --test tests/unit/phantom.test.mjs`',
    comments: { nodes: [{ body: 'VERIFY: node --test tests/unit/real.test.mjs', createdAt: '2026-09-01T00:00:00.000Z' }] },
  });
  const existsForOpts = (p) => p === 'tests/unit/real.test.mjs';
  const stillMissing = await reconcileMissingCheckPathsWithComments(flagged, {
    getIssue, pathExistsOnOriginMain: existsForOpts,
  });
  assert.deepEqual(stillMissing, []);
});

test('reconcileMissingCheckPathsWithComments: no correcting comment leaves the card flagged', async () => {
  const flagged = [{
    id: 'BRO-2', name: 'Still phantom', url: 'u2',
    cmd: 'node --test tests/unit/phantom.test.mjs', missingPaths: ['tests/unit/phantom.test.mjs'],
  }];
  const getIssue = async (id) => ({
    identifier: id,
    description: '## Acceptance criteria\n`node --test tests/unit/phantom.test.mjs`',
    comments: { nodes: [] },
  });
  const stillMissing = await reconcileMissingCheckPathsWithComments(flagged, {
    getIssue, pathExistsOnOriginMain: () => false,
  });
  assert.equal(stillMissing.length, 1);
  assert.equal(stillMissing[0].id, 'BRO-2');
});

test('reconcileMissingCheckPathsWithComments: a comment correcting to a NON-node-test command clears the flag', async () => {
  const flagged = [{
    id: 'BRO-3', name: 'Corrected to a different safe form', url: 'u3',
    cmd: 'node --test tests/unit/phantom.test.mjs', missingPaths: ['tests/unit/phantom.test.mjs'],
  }];
  const getIssue = async (id) => ({
    identifier: id,
    description: '## Acceptance criteria\n`node --test tests/unit/phantom.test.mjs`',
    comments: { nodes: [{ body: 'VERIFY: npx tsc --noEmit', createdAt: '2026-09-01T00:00:00.000Z' }] },
  });
  const stillMissing = await reconcileMissingCheckPathsWithComments(flagged, { getIssue });
  assert.deepEqual(stillMissing, []);
});

test('reconcileMissingCheckPathsWithComments: a getIssue failure fails toward reporting, not silence', async () => {
  const flagged = [{ id: 'BRO-4', name: 'Refetch fails', url: 'u4', cmd: 'node --test tests/unit/phantom.test.mjs', missingPaths: ['tests/unit/phantom.test.mjs'] }];
  const getIssue = async () => { throw new Error('network blip'); };
  const stillMissing = await reconcileMissingCheckPathsWithComments(flagged, { getIssue, log: () => {} });
  assert.equal(stillMissing.length, 1);
  assert.equal(stillMissing[0].id, 'BRO-4');
});

test('reconcileMissingCheckPathsWithComments: a test -f card is reconciled the same way (BRO-3076)', async () => {
  const flagged = [{
    id: 'BRO-5', name: 'Phantom doc', url: 'u5',
    cmd: 'test -f docs/phantom.md', missingPaths: ['docs/phantom.md'],
  }];
  const getIssue = async (id) => ({
    identifier: id,
    description: '## Acceptance criteria\n`test -f docs/phantom.md`',
    comments: { nodes: [{ body: 'VERIFY: test -f docs/real.md', createdAt: '2026-09-01T00:00:00.000Z' }] },
  });
  const existsForOpts = (p) => p === 'docs/real.md';
  const stillMissing = await reconcileMissingCheckPathsWithComments(flagged, {
    getIssue, pathExistsOnOriginMain: existsForOpts,
  });
  assert.deepEqual(stillMissing, []);
});

test('attachMissingCheckPaths: no candidates means [] without touching git', () => {
  // No card here is node --test/test -f shaped, so findCardsWithMissingCheckPaths
  // short-circuits before any git fetch — this must never hang or throw in
  // an offline test runner.
  const report = buildReport([]);
  attachMissingCheckPaths(report, [{ id: 'a', cmd: 'npx tsc --noEmit', armed: true }]);
  assert.deepEqual(report.missingCheckPaths, []);
});

test('buildReport works unchanged over evaluateLinearIssue output (shared shape)', () => {
  const evaluated = [
    evaluateLinearIssue({ identifier: 'BRO-1', title: 'Armed', description: '## Acceptance criteria\n`npx tsc --noEmit`' }),
    evaluateLinearIssue({ identifier: 'BRO-2', title: 'Prose only', description: '## Problem\nBug.' }),
  ];
  const report = buildReport(evaluated);
  assert.equal(report.total, 2);
  assert.equal(report.armedCount, 1);
  assert.equal(report.refusedCount, 1);
  assert.deepEqual(report.refused.map(r => r.id), ['BRO-2']);
});

// ── BRO-3378: vacuous-check bucket wiring ───────────────────────────────────

test('reconcileVacuousChecksWithComments: a comment correcting to a real test clears the vacuous flag', async () => {
  // The bulk sweep evaluates DESCRIPTIONS ONLY (evaluateLinearIssue passes no
  // comments), and BRO-2796 established a comment is the only way a Linear
  // description's command is ever corrected — so without this pass, an
  // already-fixed card would be reported as vacuous forever.
  const flagged = [{
    id: 'BRO-1', name: 'Vacuous', url: 'u1',
    cmd: 'test -f scripts/existing.js', kind: 'test-f-satisfied',
  }];
  const getIssue = async (id) => ({
    identifier: id,
    description: '## Acceptance criteria\n`test -f scripts/existing.js`',
    comments: { nodes: [{ body: 'VERIFY: node --test tests/unit/real.test.mjs', createdAt: '2026-09-01T00:00:00.000Z' }] },
  });
  const stillFlagged = await reconcileVacuousChecksWithComments(flagged, {
    getIssue, pathExistsOnOriginMain: () => true,
  });
  assert.deepEqual(stillFlagged, []);
});

test('reconcileVacuousChecksWithComments: an uncorrected vacuous card stays flagged', async () => {
  const flagged = [{
    id: 'BRO-2', name: 'Still vacuous', url: 'u2',
    cmd: 'test -f scripts/existing.js', kind: 'test-f-satisfied',
  }];
  const getIssue = async (id) => ({
    identifier: id,
    description: '## Acceptance criteria\n`test -f scripts/existing.js`',
    comments: { nodes: [] },
  });
  const stillFlagged = await reconcileVacuousChecksWithComments(flagged, {
    getIssue, pathExistsOnOriginMain: () => true,
  });
  assert.equal(stillFlagged.length, 1);
  assert.equal(stillFlagged[0].id, 'BRO-2');
  assert.equal(stillFlagged[0].kind, 'test-f-satisfied');
});

test('reconcileVacuousChecksWithComments: a getIssue failure fails toward reporting, not silence', async () => {
  const flagged = [{ id: 'BRO-3', name: 'x', url: 'u3', cmd: 'test -f scripts/existing.js', kind: 'test-f-satisfied' }];
  const getIssue = async () => { throw new Error('network'); };
  const stillFlagged = await reconcileVacuousChecksWithComments(flagged, { getIssue, log: () => {} });
  assert.equal(stillFlagged.length, 1);
});

test('reconcileVacuousChecksWithComments: a comment correcting to a to-be-created file clears the flag', async () => {
  // The correction a worker is actually told to make: point the check at the
  // artifact the work will produce. That path is absent, so it is falsifiable.
  const flagged = [{
    id: 'BRO-4', name: 'Vacuous', url: 'u4',
    cmd: 'test -f scripts/existing.js', kind: 'test-f-satisfied',
  }];
  const getIssue = async (id) => ({
    identifier: id,
    description: '## Acceptance criteria\n`test -f scripts/existing.js`',
    comments: { nodes: [{ body: 'VERIFY: test -f docs/new-runbook.md', createdAt: '2026-09-02T00:00:00.000Z' }] },
  });
  const stillFlagged = await reconcileVacuousChecksWithComments(flagged, {
    getIssue, pathExistsOnOriginMain: (p) => p === 'scripts/existing.js',
  });
  assert.deepEqual(stillFlagged, []);
});

test('reconcileCheckDefectsBothBuckets: a comment that moves a card BETWEEN buckets does not lose it', async () => {
  // The defect this exists to stop: a missing-path card whose comment corrects
  // it to a `test -f` on a file that EXISTS clears the missing check, and if
  // each bucket were reconciled independently it would never be offered to the
  // vacuous classifier — vanishing from both reports while being exactly the
  // defect this card was filed about.
  const initial = {
    missing: [{ id: 'BRO-9', name: 'Phantom', url: 'u9', cmd: 'test -f docs/phantom.md', missingPaths: ['docs/phantom.md'] }],
    vacuous: [],
  };
  const getIssue = async (id) => ({
    identifier: id,
    description: '## Acceptance criteria\n`test -f docs/phantom.md`',
    comments: { nodes: [{ body: 'VERIFY: test -f scripts/health-check.js', createdAt: '2026-09-03T00:00:00.000Z' }] },
  });
  const out = await reconcileCheckDefectsBothBuckets(initial, {
    getIssue, pathExistsOnOriginMain: (p) => p === 'scripts/health-check.js',
  });
  assert.deepEqual(out.missing, [], 'the phantom path was genuinely corrected');
  assert.equal(out.vacuous.length, 1, 'but the correction is vacuous and must be caught');
  assert.equal(out.vacuous[0].id, 'BRO-9');
});

test('reconcileCheckDefectsBothBuckets: each card is re-fetched exactly once across both passes', async () => {
  const fetches = [];
  const initial = {
    missing: [{ id: 'BRO-1', name: 'a', url: 'u1', cmd: 'test -f docs/phantom.md', missingPaths: ['docs/phantom.md'] }],
    vacuous: [{ id: 'BRO-2', name: 'b', url: 'u2', cmd: 'test -f scripts/health-check.js', kind: 'test-f-satisfied' }],
  };
  const getIssue = async (id) => {
    fetches.push(id);
    return { identifier: id, description: '## Acceptance criteria\n`npx tsc --noEmit`', comments: { nodes: [] } };
  };
  await reconcileCheckDefectsBothBuckets(initial, { getIssue, pathExistsOnOriginMain: () => true });
  assert.deepEqual(fetches.sort(), ['BRO-1', 'BRO-2'], 'two cards, two fetches — not four');
});

test('reconcileCheckDefectsBothBuckets: empty input short-circuits without fetching', async () => {
  const out = await reconcileCheckDefectsBothBuckets({ missing: [], vacuous: [] }, {
    getIssue: async () => { throw new Error('must not fetch'); },
  });
  assert.deepEqual(out, { missing: [], vacuous: [] });
});

test('attachMissingCheckPaths: populates BOTH buckets and never leaves vacuousChecks undefined', () => {
  // No file-naming candidates => no fetch, but the key must still exist, or
  // every downstream reader has to guard for undefined.
  const report = {};
  attachMissingCheckPaths(report, [
    { id: 'BRO-1', name: 'tsc', url: 'u1', cmd: 'npx tsc --noEmit', armed: true },
  ], { log: () => {} });
  assert.deepEqual(report.missingCheckPaths, []);
  assert.deepEqual(report.vacuousChecks, []);
});
