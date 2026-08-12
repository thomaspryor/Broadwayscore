// Tests scripts/lib/linear-cap-policy.js's pure decision logic — no live
// Linear API calls (CLAUDE.md rule 15: require() the real function).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { WARN_THRESHOLD, ARCHIVE_AGE_HOURS, isOverCapThreshold, isArchivableIssue } =
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

test('isArchivableIssue: prefers completedAt when both timestamps are present', () => {
  const issue = {
    stateType: 'completed',
    completedAt: new Date(NOW - 49 * HOUR_MS).toISOString(),
    canceledAt: new Date(NOW - 1 * HOUR_MS).toISOString(),
  };
  assert.equal(isArchivableIssue(issue, NOW), true);
});

test('isArchivableIssue: respects a custom ageHours override', () => {
  const issue = { stateType: 'completed', completedAt: new Date(NOW - 5 * HOUR_MS).toISOString() };
  assert.equal(isArchivableIssue(issue, NOW, 4), true);
  assert.equal(isArchivableIssue(issue, NOW, ARCHIVE_AGE_HOURS), false);
});

test('isArchivableIssue: false for a null issue', () => {
  assert.equal(isArchivableIssue(null, NOW), false);
});
