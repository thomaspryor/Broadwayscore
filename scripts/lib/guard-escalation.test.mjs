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
  DEFAULT_REMINDER_EVERY,
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
  // BRO-2955: the run-count threshold is now necessary but NOT sufficient —
  // callers must also clear the 24h wall-clock floor (see the time-bound tests
  // below for why the count alone meant 1h on a */30 cron).
  const OLD = { firstBlockedAt: 1_000_000_000_000, now: 1_000_000_000_000 + 25 * 3600 * 1000 };
  assert.equal(shouldAutoRecover('stale-checkout-staleness', 2, OLD), true);
  assert.equal(shouldAutoRecover('stale-checkout-staleness', 3, OLD), true);
});

test('shouldAutoRecover: threshold is overridable', () => {
  const AGED = { firstBlockedAt: 1_000_000_000_000, now: 1_000_000_000_000 + 25 * 3600 * 1000 };
  assert.equal(shouldAutoRecover('stale-checkout-staleness', 2, { ...AGED, threshold: 3 }), false);
  assert.equal(shouldAutoRecover('stale-checkout-staleness', 3, { ...AGED, threshold: 3 }), true);
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

// ── BRO-2955 review: bound auto-recovery in TIME and in COUNT ───────────────
// Two correctness blockers an independent review of the merged diff found.
// (a) The threshold was runs, not hours, so the same constant meant ONE HOUR
//     on vercel-build-guard.yml's */30 cron and ~12h on rebuild-reviews.yml's
//     ~4 runs/day. firstBlockedAt was already persisted for this and never
//     read. (b) Nothing bounded how long a guard could keep self-recovering:
//     a revoked VERCEL_TOKEN routes into the blocked path (and every network
//     error / 401 / 5xx maps there too), so the guard that exists because of
//     a $3,500 accidental-build incident would report green forever.
const T0 = 1_700_000_000_000;
const hrs = (n) => T0 + n * 3600 * 1000;

test('shouldAutoRecover: the run threshold alone does NOT auto-recover inside 24h', () => {
  assert.equal(shouldAutoRecover('stale-checkout-staleness', 2, { firstBlockedAt: T0, now: hrs(1) }), false);
  assert.equal(shouldAutoRecover('stale-checkout-staleness', 9, { firstBlockedAt: T0, now: hrs(23) }), false);
  assert.equal(shouldAutoRecover('stale-checkout-staleness', 2, { firstBlockedAt: T0, now: hrs(24) }), true);
});

test('shouldAutoRecover: refuses to recover when the timestamps needed to judge age are missing', () => {
  // Fail CLOSED. A caller that forgets to thread firstBlockedAt/now must not
  // silently fall back to the old count-only behaviour this fix replaced.
  assert.equal(shouldAutoRecover('stale-checkout-staleness', 5, {}), false);
  assert.equal(shouldAutoRecover('stale-checkout-staleness', 5, { firstBlockedAt: T0 }), false);
  assert.equal(shouldAutoRecover('stale-checkout-staleness', 5, { now: hrs(99) }), false);
  // ...unless it explicitly opts out of the time bound.
  assert.equal(shouldAutoRecover('stale-checkout-staleness', 5, { minHoursBlocked: 0 }), true);
});

test('shouldAutoRecover: stops self-recovering past the cap, so a never-clearing guard blocks loud again', () => {
  const aged = (blocks) => shouldAutoRecover('stale-checkout-staleness', blocks, { firstBlockedAt: T0, now: hrs(24 * 365), maxRecoveries: 3 });
  assert.equal(aged(2), true, 'first recovery');
  assert.equal(aged(2 + DEFAULT_REMINDER_EVERY * 2), true, 'still inside the cap');
  assert.equal(aged(2 + DEFAULT_REMINDER_EVERY * 3), false, 'cap reached — guard blocks again');
  assert.equal(aged(2 + DEFAULT_REMINDER_EVERY * 50), false, 'and stays blocked, however long it runs');
});

test('shouldAutoRecover: soft-warn guards are unaffected by either bound', () => {
  assert.equal(shouldAutoRecover('review-count-regression', 0, {}), true);
  assert.equal(shouldAutoRecover('review-count-regression', 9999, { firstBlockedAt: T0, now: T0 }), true);
});
