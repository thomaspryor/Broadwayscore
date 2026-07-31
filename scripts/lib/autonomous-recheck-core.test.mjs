import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  selectRecheckTargets, summarize, shouldExitShadow, describeResult, SHADOW_EXIT,
} = require('./autonomous-recheck-core.js');

const launch = (over = {}) => ({
  event: 'launch', taskId: '1', notionId: 'card-1', subject: 'Fix the thing',
  verifyCmd: 'node --test tests/unit/a.test.mjs', verifyReason: null, ts: '2026-07-24T00:00:00Z', ...over,
});
const done = (over = {}) => ({ id: 'card-1', name: 'Fix the thing', status: 'Done', ageDays: 0.5, ...over });

test('selects a recently-Done card that has a captured verify command', () => {
  const out = selectRecheckTargets({ doneCards: [done()], launchEntries: [launch()] });
  assert.deepEqual(out, [{ cardId: 'card-1', name: 'Fix the thing', verifyCmd: 'node --test tests/unit/a.test.mjs', reason: null, skip: null }]);
});

test('a card Done longer ago than the window is left alone', () => {
  assert.deepEqual(selectRecheckTargets({ doneCards: [done({ ageDays: 3 })], launchEntries: [launch()] }), []);
  assert.equal(selectRecheckTargets({ doneCards: [done({ ageDays: 3 })], launchEntries: [launch()], windowHours: 96 }).length, 1);
});

test('a card that never went through the dispatcher is not invented work', () => {
  assert.deepEqual(selectRecheckTargets({ doneCards: [done({ id: 'other' })], launchEntries: [launch()] }), []);
});

// The honest branch: prose acceptance criteria means the recheck REPORTS
// "no way to check this automatically", it never guesses a command.
test('a launch with no verifyCmd is reported as not machine-verifiable, with the captured reason', () => {
  const out = selectRecheckTargets({
    doneCards: [done()],
    launchEntries: [launch({ verifyCmd: null, verifyReason: 'acceptance criteria names no runnable command (prose only)' })],
  });
  assert.equal(out[0].verifyCmd, null);
  assert.match(out[0].reason, /prose only/);
});

test('a card someone is actively working right now is skipped, not re-checked', () => {
  const out = selectRecheckTargets({ doneCards: [done()], launchEntries: [launch()], isClaimed: id => id === 'card-1' });
  assert.equal(out[0].skip, 'someone is working this card right now');
  assert.equal(out[0].verifyCmd, null);
});

test('the LATEST dispatch of a card wins (a re-dispatch may change the command)', () => {
  const out = selectRecheckTargets({
    doneCards: [done()],
    launchEntries: [
      launch({ ts: '2026-07-20T00:00:00Z', verifyCmd: 'npx tsc --noEmit' }),
      launch({ ts: '2026-07-24T00:00:00Z', verifyCmd: 'npx next lint' }),
    ],
  });
  assert.equal(out[0].verifyCmd, 'npx next lint');
});

test('non-launch ledger events are ignored', () => {
  const out = selectRecheckTargets({
    doneCards: [done()],
    launchEntries: [{ event: 'dead', notionId: 'card-1', taskId: '1' }],
  });
  assert.deepEqual(out, []);
});

test('summarize counts each outcome class', () => {
  assert.deepEqual(
    summarize([{ status: 'pass' }, { status: 'fail' }, { status: 'unverifiable' }, { skip: 'x' }, { status: 'pass' }]),
    { pass: 2, fail: 1, unverifiable: 1, skipped: 1 });
});

// ── Shadow exit (S3-T5): objective, and a single false reopen resets it ─────

test('shadow exit needs all three conditions', () => {
  assert.equal(shouldExitShadow({ days: 7, rechecks: 10, falsePositives: 0 }), true);
  assert.equal(shouldExitShadow({ days: 6, rechecks: 10, falsePositives: 0 }), false, 'not enough days');
  assert.equal(shouldExitShadow({ days: 7, rechecks: 9, falsePositives: 0 }), false, 'not enough rechecks');
  assert.equal(shouldExitShadow({ days: 30, rechecks: 100, falsePositives: 1 }), false, 'one false positive blocks it');
});

test('shadow exit refuses to judge on missing numbers', () => {
  assert.equal(shouldExitShadow({}), false);
  assert.equal(shouldExitShadow({ days: 7, rechecks: 10 }), false);
  assert.equal(shouldExitShadow(), false);
});

test('the bar is the documented one', () => {
  assert.deepEqual(SHADOW_EXIT, { minDays: 7, minRechecks: 10, maxFalsePositives: 0 });
});

test('describeResult speaks plainly, with no commands or ids', () => {
  assert.equal(describeResult({ name: 'Fix X', status: 'pass' }), 'Fix X: still works');
  assert.equal(describeResult({ name: 'Fix X', status: 'fail' }), 'Fix X: its own check does not pass any more');
  assert.equal(describeResult({ name: 'Fix X', status: 'unverifiable' }), 'Fix X: no way to check this automatically');
  assert.match(describeResult({ name: 'Fix X', skip: 'someone is working this card right now' }), /^Fix X: skipped, /);
});

// ── done-time selection (2026-07-26 incident) ───────────────────────────────
// The recheck matched 0 targets every night since it shipped — primary cause
// was the Priority-sorted Done listing (fixed via notion-brain --sort edited);
// selection now also keys on explicit completion stamps (completedDate /
// lastEditedAt) instead of the derived ageDays proxy, with ageDays only as a
// fallback when neither stamp exists.
const NOW = Date.parse('2026-07-26T12:00:00Z');
const { doneWithinWindow } = require('./autonomous-recheck-core.js');

test('an OLD card completed last night is selected (the 2026-07-26 miss)', () => {
  const card = done({ ageDays: 2.5, completedDate: '2026-07-26', lastEditedAt: '2026-07-26T05:51:00.000Z' });
  const out = selectRecheckTargets({ doneCards: [card], launchEntries: [launch()], now: NOW });
  assert.equal(out.length, 1);
  assert.equal(out[0].verifyCmd, 'node --test tests/unit/a.test.mjs');
});

test('a card completed outside the window is left alone even if edited recently is false', () => {
  const card = done({ ageDays: 9, completedDate: '2026-07-20', lastEditedAt: '2026-07-20T10:00:00.000Z' });
  assert.deepEqual(selectRecheckTargets({ doneCards: [card], launchEntries: [launch()], now: NOW }), []);
  assert.equal(selectRecheckTargets({ doneCards: [card], launchEntries: [launch()], now: NOW, windowHours: 24 * 7 }).length, 1);
});

test('freshest completion stamp decides: stale completedDate but a fresh Done-flip edit still qualifies', () => {
  const card = done({ ageDays: 5, completedDate: '2026-07-20', lastEditedAt: '2026-07-26T05:00:00.000Z' });
  assert.equal(selectRecheckTargets({ doneCards: [card], launchEntries: [launch()], now: NOW }).length, 1);
});

test('no completion stamps at all: falls back to creation age, still requiring a real number', () => {
  assert.equal(doneWithinWindow({ ageDays: 0.5 }, 24, NOW), true);
  assert.equal(doneWithinWindow({ ageDays: 3 }, 24, NOW), false);
  assert.equal(doneWithinWindow({ ageDays: null }, 24, NOW), false);
  assert.equal(doneWithinWindow({}, 24, NOW), false);
});

test('garbage timestamps do not crash and do not qualify', () => {
  assert.equal(doneWithinWindow({ completedDate: 'not-a-date', lastEditedAt: 'nope' }, 24, NOW), false);
});

// ── RECHECK-AFTER stamp (task #695): deferred-effect fixes ─────────────────

const { parseRecheckAfter } = require('./autonomous-recheck-core.js');

test('parseRecheckAfter reads the stamp, case-insensitively, ignoring garbage', () => {
  assert.equal(parseRecheckAfter('RECHECK-AFTER: 2026-08-08'), Date.parse('2026-08-08T00:00:00Z'));
  assert.equal(parseRecheckAfter('recheck-after: 2026-08-08\nmore notes'), Date.parse('2026-08-08T00:00:00Z'));
  assert.equal(parseRecheckAfter('no stamp here'), null);
  assert.equal(parseRecheckAfter(''), null);
  assert.equal(parseRecheckAfter(null), null);
});

test('a RECHECK-AFTER stamp overrides the generic window entirely', () => {
  const future = { notes: 'RECHECK-AFTER: 2026-08-08', status: 'Paused' };
  assert.equal(doneWithinWindow(future, 24, Date.parse('2026-08-07T23:00:00Z')), false, 'not due yet');
  assert.equal(doneWithinWindow(future, 24, Date.parse('2026-08-08T00:00:00Z')), true, 'due the instant the day starts');
  assert.equal(doneWithinWindow(future, 24, Date.parse('2026-09-01T00:00:00Z')), true, 'stays due after, like the window does');
});

test('a Paused card with no RECHECK-AFTER stamp is never window-eligible', () => {
  const paused = { status: 'Paused', ageDays: 0.1, completedDate: null, lastEditedAt: new Date(NOW).toISOString() };
  assert.equal(doneWithinWindow(paused, 24, NOW), false);
});

test('selectRecheckTargets: Done cards with a RECHECK-AFTER stamp and no dispatch record still surface via the card notes fallback', () => {
  const card = {
    id: 'card-2', name: 'Scraping spend within thresholds', status: 'Paused',
    notes: 'RECHECK-AFTER: 2026-08-08\n\n## Acceptance criteria\n`node --test scripts/verify-provider-spend-streak.test.mjs` passes',
  };
  const now = Date.parse('2026-08-08T06:00:00Z');
  const out = selectRecheckTargets({ doneCards: [card], launchEntries: [], now });
  assert.deepEqual(out, [{
    cardId: 'card-2', name: 'Scraping spend within thresholds',
    verifyCmd: 'node --test scripts/verify-provider-spend-streak.test.mjs', reason: null, skip: null,
  }]);
});

// ── Coverage fallback (task #695): human-dispatched Done cards ─────────────

test('selectRecheckTargets: a Done card never dispatched through bsc-next is still recheckable via its own notes', () => {
  const card = {
    id: 'human-card', name: 'Manual fix', status: 'Done', ageDays: 0.2,
    notes: '## Acceptance criteria\n`npx tsc --noEmit` passes',
  };
  const out = selectRecheckTargets({ doneCards: [card], launchEntries: [], now: NOW });
  assert.deepEqual(out, [{ cardId: 'human-card', name: 'Manual fix', verifyCmd: 'npx tsc --noEmit', reason: null, skip: null }]);
});

test('selectRecheckTargets: a Done card with no dispatch record AND no runnable notes command is still not invented work', () => {
  const card = { id: 'no-cmd', name: 'Prose-only fix', status: 'Done', ageDays: 0.2, notes: 'this was fixed, trust me' };
  assert.deepEqual(selectRecheckTargets({ doneCards: [card], launchEntries: [], now: NOW }), []);
});

test('selectRecheckTargets: the fallback path still respects isClaimed', () => {
  const card = {
    id: 'claimed-card', name: 'In-flight fix', status: 'Done', ageDays: 0.2,
    notes: '## Acceptance criteria\n`npx tsc --noEmit` passes',
  };
  const out = selectRecheckTargets({
    doneCards: [card], launchEntries: [], now: NOW, isClaimed: (id) => id === 'claimed-card',
  });
  assert.deepEqual(out, [{ cardId: 'claimed-card', name: 'In-flight fix', verifyCmd: null, reason: null, skip: 'someone is working this card right now' }]);
});

test('selectRecheckTargets: a dispatch-ledger launch entry still takes priority over the notes fallback', () => {
  const card = {
    id: 'card-1', name: 'Fix the thing', status: 'Done', ageDays: 0.2,
    notes: '## Acceptance criteria\n`npx next lint` passes',
  };
  const out = selectRecheckTargets({ doneCards: [card], launchEntries: [launch()], now: NOW });
  assert.equal(out[0].verifyCmd, 'node --test tests/unit/a.test.mjs');
});
