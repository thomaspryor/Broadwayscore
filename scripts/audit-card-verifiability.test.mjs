import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { evaluateCard, buildReport, evaluateLinearIssue } = require('./audit-card-verifiability.js');

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
