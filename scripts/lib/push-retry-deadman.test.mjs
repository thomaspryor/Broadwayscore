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
  assert.match(r.message, /ledger branch could not be fetched/);
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

test('legacy records without a workflow field group under "unknown" (task #1842)', () => {
  const r = assessPushRetryDeadman([rec(1), rec(2), rec(3)], { now: NOW });
  assert.equal(r.status, 'error');
  assert.match(r.message, /unknown x3/);
});

test('workflow attribution breaks down per-workflow, most-frequent first (task #1842)', () => {
  const entries = [
    rec(1, 'retries-exhausted', { workflow: 'data-health-check.yml' }),
    rec(2, 'retries-exhausted', { workflow: 'data-health-check.yml' }),
    rec(3, 'retries-exhausted', { workflow: 'opening-night-express.yml' }),
  ];
  const r = assessPushRetryDeadman(entries, { now: NOW });
  assert.equal(r.status, 'error');
  assert.match(r.message, /data-health-check\.yml x2/);
  assert.match(r.message, /opening-night-express\.yml x1/);
  // most-frequent workflow listed before the less-frequent one
  assert.ok(r.message.indexOf('data-health-check.yml x2') < r.message.indexOf('opening-night-express.yml x1'));
});

test('autostash-conflict rows alone -> warn, not counted as push failures (BRO-3668)', () => {
  const r = assessPushRetryDeadman([rec(1, 'autostash-conflict'), rec(2, 'autostash-conflict'), rec(3, 'autostash-conflict')], { now: NOW });
  assert.equal(r.status, 'warn');
  assert.match(r.message, /No push-retry failures/);
  assert.match(r.message, /3 autostash-conflict/);
});

test('autostash-conflict rows do not lift 2 push failures to the 3+ error threshold', () => {
  const r = assessPushRetryDeadman([rec(1), rec(2), rec(3, 'autostash-conflict')], { now: NOW });
  assert.equal(r.status, 'warn');
  assert.match(r.message, /^2 push-retry failure/);
  assert.match(r.message, /1 autostash-conflict/);
});

test('BRO-3148: discarded committed files are totalled in the message', () => {
  const now = Date.now();
  const row = (extra) => ({ ts: new Date(now - 3600e3).toISOString(), reason: 'retries-exhausted', branch: 'main', workflow: 'w', ...extra });
  const r = assessPushRetryDeadman([row({ unpushedCount: 3 }), row({ unpushedCount: 2 }), row({})], { now });
  assert.match(r.message, /5 committed file\(s\) discarded across 2 run\(s\)/);
  const plain = assessPushRetryDeadman([row({})], { now });
  assert.doesNotMatch(plain.message, /discarded/);
});
