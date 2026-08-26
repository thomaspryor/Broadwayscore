// Unit tests for scripts/lib/guard-escalation.js (BRO-545: pipeline
// self-healing — auto-recovery when guards block >24h).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  isSoftWarnGuard,
  nextGuardState,
  shouldAutoRecover,
  shouldEscalate,
  buildOverrideCommand,
  buildGuardBlockedAlert,
  DEFAULT_ESCALATION_THRESHOLD,
} = require('./guard-escalation.js');

const NOW = Date.parse('2026-08-26T12:00:00Z');

test('isSoftWarnGuard: regression + drift guards are configured soft-warn', () => {
  assert.equal(isSoftWarnGuard('review-count-regression'), true);
  assert.equal(isSoftWarnGuard('review-count-drift'), true);
});

test('isSoftWarnGuard: an unlisted (hard) guard is not soft-warn', () => {
  assert.equal(isSoftWarnGuard('stale-checkout-staleness'), false);
  assert.equal(isSoftWarnGuard(''), false);
  assert.equal(isSoftWarnGuard(undefined), false);
});

test('nextGuardState: requires a numeric now', () => {
  assert.throws(() => nextGuardState(null, true, undefined), /requires now/);
  assert.throws(() => nextGuardState(null, true, NaN), /requires now/);
});

test('nextGuardState: first block from a fresh (null) prior state starts the streak at 1', () => {
  const state = nextGuardState(null, true, NOW);
  assert.equal(state.consecutiveBlocks, 1);
  assert.equal(state.firstBlockedAt, NOW);
  assert.equal(state.lastBlockedAt, NOW);
});

test('nextGuardState: consecutive blocks increment and keep the original firstBlockedAt', () => {
  const first = nextGuardState(null, true, NOW);
  const second = nextGuardState(first, true, NOW + 86400000);
  assert.equal(second.consecutiveBlocks, 2);
  assert.equal(second.firstBlockedAt, NOW); // unchanged
  assert.equal(second.lastBlockedAt, NOW + 86400000);
});

test('nextGuardState: a non-blocking run resets the streak to 0 regardless of prior state', () => {
  const blocked = nextGuardState(null, true, NOW);
  const blockedAgain = nextGuardState(blocked, true, NOW + 1000);
  const cleared = nextGuardState(blockedAgain, false, NOW + 2000);
  assert.equal(cleared.consecutiveBlocks, 0);
  assert.equal(cleared.firstBlockedAt, null);
  assert.equal(cleared.lastBlockedAt, null);
  assert.equal(cleared.lastClearedAt, NOW + 2000);
});

test('shouldAutoRecover: soft-warn guards always auto-recover, even on the very first block', () => {
  assert.equal(shouldAutoRecover('review-count-regression', 1), true);
  assert.equal(shouldAutoRecover('review-count-drift', 0), true);
});

test('shouldAutoRecover: a hard guard does NOT auto-recover below the threshold', () => {
  assert.equal(shouldAutoRecover('stale-checkout-staleness', 1), false);
  assert.equal(shouldAutoRecover('stale-checkout-staleness', 0), false);
});

test('shouldAutoRecover: a hard guard auto-recovers once it hits the default threshold (2)', () => {
  assert.equal(shouldAutoRecover('stale-checkout-staleness', 2), true);
  assert.equal(shouldAutoRecover('stale-checkout-staleness', 3), true);
});

test('shouldAutoRecover: threshold is overridable', () => {
  assert.equal(shouldAutoRecover('stale-checkout-staleness', 2, { threshold: 3 }), false);
  assert.equal(shouldAutoRecover('stale-checkout-staleness', 3, { threshold: 3 }), true);
});

test('shouldEscalate: never escalates below the threshold — a single blip never pages', () => {
  assert.equal(shouldEscalate(0), false);
  assert.equal(shouldEscalate(1), false);
});

test('shouldEscalate: fires exactly at the default threshold (2 consecutive failures)', () => {
  assert.equal(shouldEscalate(2), true);
  assert.equal(DEFAULT_ESCALATION_THRESHOLD, 2);
});

test('shouldEscalate: stays quiet between reminders, then re-fires every reminderEvery blocks past threshold', () => {
  assert.equal(shouldEscalate(3), false); // 1 past threshold
  assert.equal(shouldEscalate(4), false); // 2 past
  assert.equal(shouldEscalate(5), false); // 3 past
  assert.equal(shouldEscalate(6), true); // 4 past — reminder
  assert.equal(shouldEscalate(10), true); // 8 past — another reminder
});

test('shouldEscalate: non-integer or missing streak never escalates (fail closed)', () => {
  assert.equal(shouldEscalate(undefined), false);
  assert.equal(shouldEscalate(null), false);
  assert.equal(shouldEscalate(1.5), false);
});

test('buildOverrideCommand: requires a workflow display name', () => {
  assert.throws(() => buildOverrideCommand({}), /requires workflowDisplayName/);
});

test('buildOverrideCommand: produces the exact gh CLI invocation, quoted', () => {
  const cmd = buildOverrideCommand({ workflowDisplayName: 'Rebuild Reviews Data', reason: 'BRO-545 auto-recovery' });
  assert.equal(cmd, 'gh workflow run "Rebuild Reviews Data" -f reason="BRO-545 auto-recovery"');
});

test('buildOverrideCommand: extraFlags append after the reason flag', () => {
  const cmd = buildOverrideCommand({
    workflowDisplayName: 'Rebuild Reviews Data',
    reason: 'unblock',
    extraFlags: ['-f force_write=true'],
  });
  assert.equal(cmd, 'gh workflow run "Rebuild Reviews Data" -f reason="unblock" -f force_write=true');
});

test('buildGuardBlockedAlert: requires guardId and a numeric consecutiveBlocks', () => {
  assert.throws(() => buildGuardBlockedAlert({ consecutiveBlocks: 2 }), /requires guardId/);
  assert.throws(() => buildGuardBlockedAlert({ guardId: 'x' }), /requires consecutiveBlocks/);
});

test('buildGuardBlockedAlert: title and description name the guard, the streak, and the override command', () => {
  const overrideCommand = buildOverrideCommand({ workflowDisplayName: 'Rebuild Reviews Data', reason: 'unblock' });
  const { title, description } = buildGuardBlockedAlert({
    guardId: 'stale-checkout-staleness',
    guardLabel: 'Stale-checkout race guard',
    consecutiveBlocks: 2,
    workflowDisplayName: 'Rebuild Reviews Data',
    overrideCommand,
    runUrl: 'https://github.com/thomaspryor/Broadwayscore/actions/runs/123',
  });
  assert.match(title, /Rebuild Reviews Data blocked 2x in a row \(Stale-checkout race guard\)/);
  assert.match(description, /blocked 2 consecutive run\(s\)/);
  assert.ok(description.includes(overrideCommand), 'description must include the exact override command');
  assert.ok(description.includes('https://github.com/thomaspryor/Broadwayscore/actions/runs/123'));
});

test('buildGuardBlockedAlert: falls back to guardId when no guardLabel is given', () => {
  const { title } = buildGuardBlockedAlert({ guardId: 'stale-checkout-staleness', consecutiveBlocks: 4 });
  assert.match(title, /\(stale-checkout-staleness\)/);
});

test('buildGuardBlockedAlert: default impact text is generic, not the first caller\'s reviews.json-specific wording (BRO-2424)', () => {
  const { description } = buildGuardBlockedAlert({ guardId: 'some-other-guard', consecutiveBlocks: 2, workflowDisplayName: 'Some Other Workflow' });
  assert.ok(!description.includes('reviews.json'), 'a reused caller must not inherit check-rebuild-staleness.js-specific wording by default');
  assert.match(description, /Some Other Workflow has not completed its normal work/);
});

test('buildGuardBlockedAlert: explicit impact text overrides the generic default', () => {
  const { description } = buildGuardBlockedAlert({ guardId: 'x', consecutiveBlocks: 2, impact: 'the Vercel ignore-build-step setting may still be drifted' });
  assert.ok(description.includes('the Vercel ignore-build-step setting may still be drifted'));
});
