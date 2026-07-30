import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { evaluateCard, buildReport } = require('./audit-card-verifiability.js');

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
