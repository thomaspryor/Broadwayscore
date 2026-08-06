import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  shouldMarkPlanReady,
  shouldEscalateToFix,
  extractConditionKey,
  parseVerifiedOutcomeLine,
  ESCALATABLE_CONDITIONS,
  ESCALATABLE_PRIORITIES,
  AUTO_ROUTER_TAG,
} = require('./plan-ready.js');

// ── shouldMarkPlanReady (EXISTING behavior — regression) ─────────────────

test('shouldMarkPlanReady: true for a plan-only action, no priority, Not started', () => {
  assert.equal(shouldMarkPlanReady({ action: 'Plan', priority: null, status: 'Not started' }), true);
});

test('shouldMarkPlanReady: true for Investigate/Review/Plan+Review too (all plan-only)', () => {
  for (const action of ['Investigate', 'Review', 'Plan+Review']) {
    assert.equal(shouldMarkPlanReady({ action, priority: null, status: 'Not started' }), true, action);
  }
});

test('shouldMarkPlanReady: false when action implements code (Fix/Start)', () => {
  assert.equal(shouldMarkPlanReady({ action: 'Fix', priority: null, status: 'Not started' }), false);
  assert.equal(shouldMarkPlanReady({ action: 'Start', priority: null, status: 'Not started' }), false);
});

test('shouldMarkPlanReady: false when card already has a priority', () => {
  assert.equal(shouldMarkPlanReady({ action: 'Plan', priority: 'P1 Next', status: 'Not started' }), false);
});

test('shouldMarkPlanReady: false when status is not "Not started" (owner is working it or closed it)', () => {
  for (const status of ['In progress', 'Done', 'Paused']) {
    assert.equal(shouldMarkPlanReady({ action: 'Plan', priority: null, status }), false, status);
  }
});

// ── extractConditionKey ───────────────────────────────────────────────────

test('extractConditionKey: pulls the conditionKey out of buildCardNotes()-shaped notes', () => {
  const notes = '## Problem\nsomething broke\n\n## Acceptance criteria\nCondition "gap:hamilton-2026/nyt.json" no longer fires on the next check. If it recurs...';
  assert.equal(extractConditionKey(notes), 'gap:hamilton-2026/nyt.json');
});

test('extractConditionKey: null for notes without the marker', () => {
  assert.equal(extractConditionKey('hand-written card, no marker here'), null);
  assert.equal(extractConditionKey(''), null);
  assert.equal(extractConditionKey(undefined), null);
});

// ── parseVerifiedOutcomeLine ───────────────────────────────────────────────

test('parseVerifiedOutcomeLine: parses a trailing VERIFIED line', () => {
  const text = 'Did the thing.\nAnother line.\n\nVERIFIED: node scripts/foo.js --check — exit 0, 3 rows updated';
  const result = parseVerifiedOutcomeLine(text);
  assert.deepEqual(result, { status: 'VERIFIED', detail: 'node scripts/foo.js --check — exit 0, 3 rows updated' });
});

test('parseVerifiedOutcomeLine: parses a trailing UNVERIFIED line', () => {
  const text = 'Investigated the gap.\n\nUNVERIFIED: no credential for this outlet\'s cookie jar on this machine';
  const result = parseVerifiedOutcomeLine(text);
  assert.deepEqual(result, { status: 'UNVERIFIED', detail: 'no credential for this outlet\'s cookie jar on this machine' });
});

test('parseVerifiedOutcomeLine: tolerant of trailing blank lines / markdown noise after the marker', () => {
  const text = 'VERIFIED: node --check scripts/foo.js — syntax OK\n\n\n```\n\n';
  const result = parseVerifiedOutcomeLine(text);
  assert.equal(result.status, 'VERIFIED');
});

test('parseVerifiedOutcomeLine: null when no marker line is present at all', () => {
  assert.equal(parseVerifiedOutcomeLine('Just a summary with no marker.'), null);
});

test('parseVerifiedOutcomeLine: null/undefined/empty text is null, not a throw', () => {
  assert.equal(parseVerifiedOutcomeLine(''), null);
  assert.equal(parseVerifiedOutcomeLine(undefined), null);
  assert.equal(parseVerifiedOutcomeLine(null), null);
});

test('parseVerifiedOutcomeLine: only scans the last 20 lines (a marker buried earlier is ignored)', () => {
  const noise = Array.from({ length: 25 }, (_, i) => `line ${i}`).join('\n');
  const text = `VERIFIED: this is buried too early — should not count\n${noise}`;
  assert.equal(parseVerifiedOutcomeLine(text), null);
});

// ── shouldEscalateToFix — full decision table ────────────────────────────

const BASE_CARD = {
  tags: [AUTO_ROUTER_TAG],
  priority: 'P1 Next',
  notes: 'Condition "gap:show-x/nyt.json" no longer fires on the next check.',
};
const BASE_CTX = {
  hadChanges: false,
  alreadyEscalated: false,
  escalatedThisCycle: 0,
  killSwitch: false,
};

test('shouldEscalateToFix: true when every guard is satisfied (the eligible case)', () => {
  assert.equal(shouldEscalateToFix({ ...BASE_CARD }, { ...BASE_CTX }), true);
});

test('shouldEscalateToFix: true for the backstop: condition family too', () => {
  const card = { ...BASE_CARD, notes: 'Condition "backstop:show-y/variety.json" no longer fires on the next check.' };
  assert.equal(shouldEscalateToFix(card, { ...BASE_CTX }), true);
});

test('shouldEscalateToFix: false — (a) not tagged alert-router (owner-authored card)', () => {
  const card = { ...BASE_CARD, tags: ['scoring'] };
  assert.equal(shouldEscalateToFix(card, { ...BASE_CTX }), false);
});

test('shouldEscalateToFix: false — (a) no tags at all', () => {
  const card = { ...BASE_CARD, tags: [] };
  assert.equal(shouldEscalateToFix(card, { ...BASE_CTX }), false);
});

test('shouldEscalateToFix: false — (b) priority below P0/P1', () => {
  for (const priority of ['P2 Later', 'P3 Backlog', null, undefined]) {
    const card = { ...BASE_CARD, priority };
    assert.equal(shouldEscalateToFix(card, { ...BASE_CTX }), false, String(priority));
  }
});

test('shouldEscalateToFix: true for P0 Now too (not just P1 Next)', () => {
  const card = { ...BASE_CARD, priority: 'P0 Now' };
  assert.equal(shouldEscalateToFix(card, { ...BASE_CTX }), true);
});

test('shouldEscalateToFix: false — (c) the stage made a durable change', () => {
  assert.equal(shouldEscalateToFix({ ...BASE_CARD }, { ...BASE_CTX, hadChanges: true }), false);
});

test('shouldEscalateToFix: false — (d) condition not on the allowlist', () => {
  const card = { ...BASE_CARD, notes: 'Condition "contradiction:show-z/wapo.json" no longer fires on the next check.' };
  assert.equal(shouldEscalateToFix(card, { ...BASE_CTX }), false);
});

test('shouldEscalateToFix: false — (d) no conditionKey extractable at all', () => {
  const card = { ...BASE_CARD, notes: 'A hand-written card with no marker.' };
  assert.equal(shouldEscalateToFix(card, { ...BASE_CTX }), false);
});

test('shouldEscalateToFix: (d) card.conditionKey pre-extracted by the caller wins over notes parsing', () => {
  const card = { ...BASE_CARD, notes: 'no marker here', conditionKey: 'gap:show-x/nyt.json' };
  assert.equal(shouldEscalateToFix(card, { ...BASE_CTX }), true);
});

test('shouldEscalateToFix: false — (e) already escalated once', () => {
  assert.equal(shouldEscalateToFix({ ...BASE_CARD }, { ...BASE_CTX, alreadyEscalated: true }), false);
});

test('shouldEscalateToFix: false — (f) per-cycle rate limit hit (2 already escalated this cycle)', () => {
  assert.equal(shouldEscalateToFix({ ...BASE_CARD }, { ...BASE_CTX, escalatedThisCycle: 2 }), false);
});

test('shouldEscalateToFix: true right at the boundary — 1 escalated this cycle is still under the cap of 2', () => {
  assert.equal(shouldEscalateToFix({ ...BASE_CARD }, { ...BASE_CTX, escalatedThisCycle: 1 }), true);
});

test('shouldEscalateToFix: false — (g) kill switch on', () => {
  assert.equal(shouldEscalateToFix({ ...BASE_CARD }, { ...BASE_CTX, killSwitch: true }), false);
});

test('shouldEscalateToFix: false on missing card or ctx (defaults closed)', () => {
  assert.equal(shouldEscalateToFix(null, { ...BASE_CTX }), false);
  assert.equal(shouldEscalateToFix({ ...BASE_CARD }, null), false);
  assert.equal(shouldEscalateToFix(undefined, undefined), false);
});

test('ESCALATABLE_CONDITIONS: exactly the two audit-t1-silent-gaps.js condition prefixes', () => {
  assert.deepEqual(ESCALATABLE_CONDITIONS, ['gap:', 'backstop:']);
});

test('ESCALATABLE_PRIORITIES: exactly P0/P1', () => {
  assert.deepEqual([...ESCALATABLE_PRIORITIES].sort(), ['P0 Now', 'P1 Next'].sort());
});
