// BRO-4141: parallel CI runners each read a stale cooldown ledger and all sent
// "main test.yml STILL red" (7 emails in 20 min through a 24h cooldown on
// 2026-09-23). Resend's Idempotency-Key now makes the first send win.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { alertIdempotencyKey } = require('./owner-alert-router.js');
const { isIdempotentDuplicate } = require('./discord-notify.js');

const T = Date.parse('2026-09-23T04:01:00Z');

test('runs minutes apart in one cooldown window share a key', () => {
  const k = 'test-yml:main-streak-escalation';
  assert.equal(alertIdempotencyKey(k, 24, T), alertIdempotencyKey(k, 24, T + 20 * 60e3));
});

test('different conditions never share a key', () => {
  assert.notEqual(alertIdempotencyKey('a', 24, T), alertIdempotencyKey('b', 24, T));
});

test('the next window gets a new key, so a still-open condition can page again', () => {
  const k = 'x';
  assert.notEqual(alertIdempotencyKey(k, 6, T), alertIdempotencyKey(k, 6, T + 6 * 3600e3));
});

test('windows are capped at Resend\'s 24h key lifetime', () => {
  const k = 'x';
  assert.notEqual(alertIdempotencyKey(k, 168, T), alertIdempotencyKey(k, 168, T + 25 * 3600e3));
});

test('a missing or zero cooldown still yields a usable key', () => {
  assert.match(alertIdempotencyKey('x', undefined, T), /^owner-alert:x:\d+$/);
  assert.match(alertIdempotencyKey('x', 0, T), /^owner-alert:x:\d+$/);
});

test('key stays within Resend\'s 256-char limit', () => {
  assert.ok(alertIdempotencyKey('k'.repeat(400), 24, T).length <= 256);
});

// Response bodies copied from a live Resend probe on 2026-09-25.
test('Resend 409 idempotency replies count as "already sent"', () => {
  assert.equal(isIdempotentDuplicate(409, '{"statusCode":409,"name":"invalid_idempotent_request","message":"This idempotency key has been used..."}'), true);
  assert.equal(isIdempotentDuplicate(409, '{"name":"concurrent_idempotent_requests"}'), true);
});

test('other failures are still failures', () => {
  assert.equal(isIdempotentDuplicate(409, '{"name":"conflict"}'), false);
  assert.equal(isIdempotentDuplicate(422, 'invalid_idempotency_key'), false);
  assert.equal(isIdempotentDuplicate(500, ''), false);
});

test('direct senders without a key: same title in the same hour shares a default key', () => {
  const { defaultIdempotencyKey } = require('./discord-notify.js');
  assert.equal(defaultIdempotencyKey('Image Fetch Failed', T), defaultIdempotencyKey('Image Fetch Failed', T + 30 * 60e3));
  assert.notEqual(defaultIdempotencyKey('Image Fetch Failed', T), defaultIdempotencyKey('Deploy Failed', T));
  assert.notEqual(defaultIdempotencyKey('Image Fetch Failed', T), defaultIdempotencyKey('Image Fetch Failed', T + 3600e3));
});
