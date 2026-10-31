// Tests scripts/lib/linear-cap-policy.js's pure decision logic — no live
// Linear API calls (CLAUDE.md rule 15: require() the real function).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
import { readFileSync } from 'node:fs';

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

test('isArchivableIssue: true for a duplicate-type issue past the age threshold (BRO-2466 — the third terminal type, uses canceledAt)', () => {
  const issue = { stateType: 'duplicate', canceledAt: new Date(NOW - 49 * HOUR_MS).toISOString() };
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

// canceledAt = when cancel was CLICKED (past). cancelAt = when the paid period
// ENDS (future). The plan is still paid until cancelAt, so only a LAPSED period
// re-arms the cap. Conflating the two would restart the daily false alert the
// moment cancel is clicked and keep it firing for up to a year while paid.
const CAP_NOW = Date.parse('2026-08-13T00:00:00Z');

test('isCapEnforced: cancel scheduled in the FUTURE keeps the cap lifted', () => {
  assert.equal(isCapEnforced(
    { type: 'basic_yearly_10', canceledAt: '2026-08-12T00:00:00Z', cancelAt: '2027-08-12T00:00:00Z' },
    CAP_NOW), false);
});

test('isCapEnforced: a LAPSED paid period re-arms the cap', () => {
  assert.equal(isCapEnforced({ type: 'basic_yearly_10', cancelAt: '2026-08-01T00:00:00Z' }, CAP_NOW), true);
});

test('isCapEnforced: cancel requested with no end date re-arms (conservative)', () => {
  assert.equal(isCapEnforced({ type: 'basic_yearly_10', canceledAt: '2026-08-12T00:00:00Z' }, CAP_NOW), true);
});

test('isCapEnforced: the expiry boundary is inclusive (cancelAt === now is lapsed)', () => {
  // The single line most likely to regress to `<`. At the exact expiry instant
  // the paid period has ended, so the cap is armed.
  const at = new Date(CAP_NOW).toISOString();
  assert.equal(isCapEnforced({ type: 'basic_yearly_10', cancelAt: at }, CAP_NOW), true);
  assert.equal(isCapEnforced({ type: 'basic_yearly_10', cancelAt: at }, CAP_NOW - 1), false);
});

test('isCapEnforced: an empty-string cancelAt is treated as absent', () => {
  // '' is falsy, so it falls through to the canceledAt signal rather than
  // being parsed. Documented so the asymmetry with 'garbage' (which arms the
  // cap) is deliberate rather than accidental.
  assert.equal(isCapEnforced({ type: 'basic_yearly_10', cancelAt: '' }, CAP_NOW), false);
  assert.equal(isCapEnforced({ type: 'basic_yearly_10', cancelAt: '', canceledAt: 'x' }, CAP_NOW), true);
});

test('isCapEnforced: an unparseable cancelAt fails SAFE (cap armed)', () => {
  // A cancellation whose end date we cannot read is still a cancellation.
  // Lifting the cap here would leave the guard silently off through a real
  // lapse until createIssue starts throwing USAGE_LIMIT_EXCEEDED.
  assert.equal(isCapEnforced({ type: 'basic_yearly_10', cancelAt: 'not-a-date' }, CAP_NOW), true);
  assert.equal(isCapEnforced({ type: 'basic_yearly_10', cancelAt: 'not-a-date', canceledAt: 'x' }, CAP_NOW), true);
});

test('isCapEnforced: unrecognised shapes fail safe (cap stays armed)', () => {
  assert.equal(isCapEnforced({}), true);
  assert.equal(isCapEnforced('paid'), true);
  assert.equal(isCapEnforced(42), true);
});

// The predicate's inputs must actually be FETCHED. isCapEnforced re-arms on
// canceledAt/cancelAt, but a query selecting only `type` can never supply them
// — that silently makes the branch dead code and leaves the cap guard disabled
// straight through a cancellation. Asserting on hand-built objects passes
// either way, so assert the selection set at the source instead. (This is the
// exact bug the review caught after the first fix shipped.)
test('check-linear-cap queries every field isCapEnforced reads', () => {
  const src = readFileSync(new URL('../../scripts/check-linear-cap.js', import.meta.url), 'utf8');
  const m = src.match(/organization\{\s*subscription\{([^}]*)\}/);
  assert.ok(m, 'could not find the organization.subscription selection set');
  for (const field of ['type', 'canceledAt', 'cancelAt']) {
    assert.ok(new RegExp(`\\b${field}\\b`).test(m[1]),
      `subscription selection set is missing "${field}" — isCapEnforced reads it`);
  }
});
