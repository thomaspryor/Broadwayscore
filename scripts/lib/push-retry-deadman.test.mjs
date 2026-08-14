/**
 * Pins the BRO-231 / task #1221 fix: the ledger being gitignored/absent in CI
 * must report 'warn' (cannot verify), never the vacuous 'pass' that let 59
 * real local push failures render green in the CI-generated morning digest.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { assessPushRetryDeadman, NAME } = require('./push-retry-deadman.js');

const NOW = Date.parse('2026-08-14T12:00:00.000Z');
const at = (h) => new Date(NOW - h * 3600 * 1000).toISOString();
const rec = (h, reason = 'retries-exhausted', extra = {}) => ({
  ts: at(h), branch: 'main', remote: 'origin', reason, ...extra,
});

test('null entries (ledger absent/unreadable) -> warn, never a false pass', () => {
  const r = assessPushRetryDeadman(null, { now: NOW });
  assert.equal(r.name, NAME);
  assert.equal(r.status, 'warn');
  assert.match(r.message, /absent here/);
});

test('empty array (ledger present, genuinely clean) -> pass', () => {
  const r = assessPushRetryDeadman([], { now: NOW });
  assert.equal(r.status, 'pass');
});

test('1 non-noop failure in window -> warn', () => {
  const r = assessPushRetryDeadman([rec(1)], { now: NOW });
  assert.equal(r.status, 'warn');
  assert.match(r.message, /1 push-retry failure/);
});

test('2 non-noop failures in window -> still warn (below the 3+ threshold)', () => {
  const r = assessPushRetryDeadman([rec(1), rec(2)], { now: NOW });
  assert.equal(r.status, 'warn');
});

test('3 non-noop failures in window -> error (threshold crossed)', () => {
  const r = assessPushRetryDeadman([rec(1), rec(2), rec(3)], { now: NOW });
  assert.equal(r.status, 'error');
  assert.match(r.message, /3 push-retry failure/);
});

test('a single noop-rebase failure -> error regardless of count', () => {
  const r = assessPushRetryDeadman([rec(1, 'noop-rebase-abort')], { now: NOW });
  assert.equal(r.status, 'error');
  assert.match(r.message, /NO-OP-rebase/);
});

test('failures older than the 7-day window are excluded', () => {
  const r = assessPushRetryDeadman([rec(8 * 24)], { now: NOW });
  assert.equal(r.status, 'pass');
});

test('a record exactly at the 7-day cutoff is still counted', () => {
  const r = assessPushRetryDeadman([rec(7 * 24)], { now: NOW });
  assert.equal(r.status, 'warn');
});

test('a record with an unparseable ts is ignored, not counted', () => {
  const r = assessPushRetryDeadman([{ ts: 'not-a-date', reason: 'retries-exhausted' }], { now: NOW });
  assert.equal(r.status, 'pass');
});
