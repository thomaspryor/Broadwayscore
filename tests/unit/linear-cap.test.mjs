// Tests scripts/lib/linear-cap-policy.js's pure decision logic — no live
// Linear API calls (CLAUDE.md rule 15: require() the real function).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { WARN_THRESHOLD, ARCHIVE_AGE_HOURS, isOverCapThreshold, isCapEnforced, isArchivableIssue } =
  require('../../scripts/lib/linear-cap-policy.js');

const HOUR_MS = 60 * 60 * 1000;
const NOW = Date.parse('2026-08-12T12:00:00.000Z');

test('isOverCapThreshold: false below the threshold', () => {
  assert.equal(isOverCapThreshold(199, WARN_THRESHOLD), false);
});

test('isOverCapThreshold: true at the threshold', () => {
  assert.equal(isOverCapThreshold(200, WARN_THRESHOLD), true);
});

test('isOverCapThreshold: true above the threshold', () => {
  assert.equal(isOverCapThreshold(230, WARN_THRESHOLD), true);
});

test('isOverCapThreshold: respects a custom threshold', () => {
  assert.equal(isOverCapThreshold(50, 40), true);
  assert.equal(isOverCapThreshold(30, 40), false);
});

test('isArchivableIssue: false for a non-terminal state (started)', () => {
  const issue = { stateType: 'started', completedAt: new Date(NOW - 100 * HOUR_MS).toISOString() };
  assert.equal(isArchivableIssue(issue, NOW), false);
});

test('isArchivableIssue: false when completed less than the age threshold ago', () => {
  const issue = { stateType: 'completed', completedAt: new Date(NOW - 1 * HOUR_MS).toISOString() };
  assert.equal(isArchivableIssue(issue, NOW), false);
});

test('isArchivableIssue: true when completed at least the age threshold ago', () => {
  const issue = { stateType: 'completed', completedAt: new Date(NOW - 49 * HOUR_MS).toISOString() };
  assert.equal(isArchivableIssue(issue, NOW), true);
});

test('isArchivableIssue: true for a canceled issue past the age threshold', () => {
  const issue = { stateType: 'canceled', canceledAt: new Date(NOW - 49 * HOUR_MS).toISOString() };
  assert.equal(isArchivableIssue(issue, NOW), true);
});

test('isArchivableIssue: false when completed/canceled but no timestamp present', () => {
  const issue = { stateType: 'completed', completedAt: null, canceledAt: null };
  assert.equal(isArchivableIssue(issue, NOW), false);
});

test('isArchivableIssue: uses completedAt (not canceledAt) when stateType is completed, even if canceledAt is also set', () => {
  // A recent canceledAt from an earlier pass through Canceled shouldn't matter
  // once the issue is back at Done — old canceledAt would wrongly make this
  // look archivable-since-the-stale-cancellation instead of the real close.
  const issue = {
    stateType: 'completed',
    completedAt: new Date(NOW - 1 * HOUR_MS).toISOString(),
    canceledAt: new Date(NOW - 49 * HOUR_MS).toISOString(),
  };
  assert.equal(isArchivableIssue(issue, NOW), false);
});

test('isArchivableIssue: uses canceledAt (not a stale completedAt) when stateType is canceled', () => {
  // Issue went Done -> Canceled: completedAt is stale from the earlier Done
  // pass. Must not archive on that old timestamp — only the actual
  // cancellation, which happened recently, governs the 48h buffer.
  const issue = {
    stateType: 'canceled',
    completedAt: new Date(NOW - 49 * HOUR_MS).toISOString(),
    canceledAt: new Date(NOW - 1 * HOUR_MS).toISOString(),
  };
  assert.equal(isArchivableIssue(issue, NOW), false);
});

test('isArchivableIssue: exact age boundary is inclusive (>=)', () => {
  const issue = { stateType: 'completed', completedAt: new Date(NOW - ARCHIVE_AGE_HOURS * HOUR_MS).toISOString() };
  assert.equal(isArchivableIssue(issue, NOW), true);
});

test('isArchivableIssue: false for a bare object with no stateType at all', () => {
  assert.equal(isArchivableIssue({}, NOW), false);
});

test('isOverCapThreshold: uses WARN_THRESHOLD when no threshold argument is passed', () => {
  assert.equal(isOverCapThreshold(WARN_THRESHOLD - 1), false);
  assert.equal(isOverCapThreshold(WARN_THRESHOLD), true);
});

test('isArchivableIssue: respects a custom ageHours override', () => {
  const issue = { stateType: 'completed', completedAt: new Date(NOW - 5 * HOUR_MS).toISOString() };
  assert.equal(isArchivableIssue(issue, NOW, 4), true);
  assert.equal(isArchivableIssue(issue, NOW, ARCHIVE_AGE_HOURS), false);
});

test('isArchivableIssue: false for a null issue', () => {
  assert.equal(isArchivableIssue(null, NOW), false);
});

// --- isCapEnforced: the 250 ceiling is a FREE-tier limit only ---------------
// Owner upgraded to basic_yearly_10 on 2026-08-12; without this predicate the
// >=200 warn fires forever as a decision row in the daily digest.

test('isCapEnforced: free tier (no subscription) keeps the cap armed', () => {
  assert.equal(isCapEnforced(null), true);
  assert.equal(isCapEnforced(undefined), true);
});

test('isCapEnforced: an active paid subscription lifts the cap', () => {
  assert.equal(isCapEnforced({ type: 'basic_yearly_10' }), false);
  assert.equal(isCapEnforced({ type: 'business' }), false);
});

test('isCapEnforced: a CANCELED subscription re-arms the cap', () => {
  // Linear keeps a truthy PaidSubscription row after cancellation until the
  // period ends. A bare truthiness test would disable the guard exactly when
  // the workspace is about to fall back to free tier.
  assert.equal(isCapEnforced({ type: 'basic_yearly_10', canceledAt: '2026-09-01T00:00:00Z' }), true);
  assert.equal(isCapEnforced({ type: 'basic_yearly_10', cancelAt: '2026-09-01T00:00:00Z' }), true);
});

test('isCapEnforced: unrecognised shapes fail safe (cap stays armed)', () => {
  assert.equal(isCapEnforced({}), true);
  assert.equal(isCapEnforced('paid'), true);
  assert.equal(isCapEnforced(42), true);
});
