import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { withGmailRetry, isRetryableGmailError, retryDelayMs } = require('./gmail-quota-retry.js');

// The exact error run 38343920837 died on.
const QUOTA = Object.assign(new Error("Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user' of service 'gmail.googleapis.com' for consumer 'project_number:1'."), { code: 429 });

test('rate limits and 5xx are retryable; auth and not-found errors are not', () => {
  assert.equal(isRetryableGmailError(QUOTA), true);
  assert.equal(isRetryableGmailError(Object.assign(new Error('x'), { code: 403, errors: [{ reason: 'userRateLimitExceeded' }] })), true);
  assert.equal(isRetryableGmailError(Object.assign(new Error('x'), { code: 503 })), true);
  // gaxios 7 shape: string code from the cause, HTTP status on .status, reasons in response.data.
  assert.equal(isRetryableGmailError(Object.assign(new Error('x'), { code: 'ERR_X', status: 429 })), true);
  assert.equal(isRetryableGmailError(Object.assign(new Error('x'), { status: 403, response: { status: 403, data: { error: { errors: [{ reason: 'rateLimitExceeded' }] } } } })), true);
  assert.equal(isRetryableGmailError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })), true);
  assert.equal(isRetryableGmailError(Object.assign(new Error('invalid_grant'), { code: 400 })), false);
  assert.equal(isRetryableGmailError(Object.assign(new Error('Requested entity was not found.'), { code: 404 })), false);
  assert.equal(isRetryableGmailError(Object.assign(new Error('forbidden'), { code: 403, errors: [{ reason: 'insufficientPermissions' }] })), false);
});

test('delay honours Retry-After, else backs off exponentially up to the cap', () => {
  assert.equal(retryDelayMs({ response: { headers: { 'retry-after': '7' } } }, 0), 7000);
  assert.equal(retryDelayMs({ response: { headers: new Headers({ 'retry-after': '7' }) } }, 0), 7000);
  const now = Date.parse('2026-10-13T00:00:00Z');
  assert.equal(retryDelayMs({ response: { headers: new Headers({ 'retry-after': 'Tue, 13 Oct 2026 00:00:09 GMT' }) } }, 0, { nowMs: now }), 9000);
  assert.equal(retryDelayMs(QUOTA, 0, { random: () => 1 }), 2000);
  assert.equal(retryDelayMs(QUOTA, 3, { random: () => 1 }), 16000);
  assert.equal(retryDelayMs(QUOTA, 10, { random: () => 1 }), 60000);
  assert.equal(retryDelayMs(QUOTA, 10, { random: () => 0 }), 30000);
});

test('a quota error followed by success returns the result after waiting', async () => {
  const waits = [];
  let calls = 0;
  const out = await withGmailRetry(async () => { if (++calls < 3) throw QUOTA; return 'ok'; }, { sleep: async (ms) => { waits.push(ms); }, log: () => {} });
  assert.equal(out, 'ok');
  assert.equal(calls, 3);
  assert.equal(waits.length, 2);
});

test('a non-retryable error throws at once; a persistent quota error gives up after maxAttempts', async () => {
  let calls = 0;
  const bad = Object.assign(new Error('invalid_grant'), { code: 400 });
  await assert.rejects(withGmailRetry(async () => { calls++; throw bad; }, { sleep: async () => {}, log: () => {} }), /invalid_grant/);
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(withGmailRetry(async () => { calls++; throw QUOTA; }, { maxAttempts: 4, sleep: async () => {}, log: () => {} }), /Quota exceeded/);
  assert.equal(calls, 4);
});
