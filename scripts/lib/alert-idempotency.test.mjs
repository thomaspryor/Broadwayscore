// BRO-4141: parallel CI runners each read a stale cooldown ledger and all sent
// "main test.yml STILL red" (7 emails in 20 min through a 24h cooldown on
// 2026-09-23). Resend's Idempotency-Key now makes the first send win.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { alertIdempotencyKey } = require('./owner-alert-router.js');
const { classifyResendResponse, defaultIdempotencyKey } = require('./discord-notify.js');

const T = Date.parse('2026-09-23T04:01:00Z');

test('runs minutes apart in one cooldown window share a key', () => {
  const k = 'test-yml:main-streak-escalation';
  assert.equal(alertIdempotencyKey(k, 24, T), alertIdempotencyKey(k, 24, T + 20 * 60e3));
});

test('different conditions never share a key', () => {
  assert.notEqual(alertIdempotencyKey('a', 24, T), alertIdempotencyKey('b', 24, T));
});

test('the next window gets a new key, so a still-open condition can page again', () => {
  assert.notEqual(alertIdempotencyKey('x', 6, T), alertIdempotencyKey('x', 6, T + 6 * 3600e3));
});

test('windows are capped at Resend\'s 24h key lifetime', () => {
  assert.notEqual(alertIdempotencyKey('x', 168, T), alertIdempotencyKey('x', 168, T + 25 * 3600e3));
});

test('a missing or zero cooldown still yields a usable key', () => {
  assert.match(alertIdempotencyKey('x', undefined, T), /^owner-alert:[0-9a-f]{20}:\d+$/);
  assert.match(alertIdempotencyKey('x', 0, T), /^owner-alert:[0-9a-f]{20}:\d+$/);
});

test('a very long conditionKey keeps its identity AND its time bucket', () => {
  const a = 'k'.repeat(400) + ':show-a';
  const b = 'k'.repeat(400) + ':show-b';
  assert.ok(alertIdempotencyKey(a, 24, T).length <= 256);
  assert.notEqual(alertIdempotencyKey(a, 24, T), alertIdempotencyKey(b, 24, T));
  assert.notEqual(alertIdempotencyKey(a, 1, T), alertIdempotencyKey(a, 1, T + 3600e3));
});

// Response bodies copied from a live Resend probe on 2026-09-25.
test('Resend replies: sent / duplicate / in-flight / failed', () => {
  assert.equal(classifyResendResponse(200, '{"id":"x"}'), 'sent');
  assert.equal(classifyResendResponse(409, '{"statusCode":409,"name":"invalid_idempotent_request","message":"..."}'), 'duplicate');
  assert.equal(classifyResendResponse(409, '{"name":"concurrent_idempotent_requests"}'), 'in-flight');
  assert.equal(classifyResendResponse(409, '{"name":"conflict"}'), 'failed');
  assert.equal(classifyResendResponse(422, 'invalid_idempotency_key'), 'failed');
  assert.equal(classifyResendResponse(0, 'request error'), 'failed');
});

test('direct senders: only an identical message shares a default key', () => {
  const k1 = defaultIdempotencyKey('[CRITICAL] Image Fetch Failed<p>run 1</p>', T);
  assert.equal(k1, defaultIdempotencyKey('[CRITICAL] Image Fetch Failed<p>run 1</p>', T + 30 * 60e3));
  assert.notEqual(k1, defaultIdempotencyKey('[CRITICAL] Image Fetch Failed<p>run 2</p>', T));
  assert.notEqual(k1, defaultIdempotencyKey('[CRITICAL] Image Fetch Failed<p>run 1</p>', T + 3600e3));
});
