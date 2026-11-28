import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { sendWithRetry, isRetryableSendError, buildIdempotencyKey } = createRequire(import.meta.url)('./resend-send-retry.js');

const noSleep = { sleep: async () => {}, log: () => {} };

test('retries the 2026-10-23 failure (timeout) then succeeds', async () => {
  let n = 0;
  const r = await sendWithRetry(async () => {
    if (++n < 3) throw new Error('Resend request timed out after 15s');
    return { id: 'abc' };
  }, noSleep);
  assert.equal(r.id, 'abc');
  assert.equal(n, 3);
});

test('gives up after the delay budget and rethrows', async () => {
  let n = 0;
  await assert.rejects(sendWithRetry(async () => { n++; throw new Error('HTTP 503: x'); }, { ...noSleep, delaysMs: [1, 1] }), /503/);
  assert.equal(n, 3);
});

test('non-transient 4xx is not retried', async () => {
  let n = 0;
  await assert.rejects(sendWithRetry(async () => { n++; throw new Error('HTTP 403: bad key'); }, noSleep), /403/);
  assert.equal(n, 1);
});

test('classifier', () => {
  assert.ok(isRetryableSendError(new Error('HTTP 429: slow')));
  assert.ok(isRetryableSendError(new Error('read ECONNRESET')));
  assert.ok(!isRetryableSendError(new Error('HTTP 422: invalid')));
});

test('idempotency key is stable per day+recipient', () => {
  assert.equal(buildIdempotencyKey('opening-digest', '2026-10-23', 'A@b.com'), 'opening-digest/2026-10-23/a@b.com');
});

test('409 concurrent is retried, 409 payload-mismatch is not', async () => {
  assert.ok(isRetryableSendError(new Error('HTTP 409: {"name":"concurrent_idempotent_requests"}')));
  assert.ok(!isRetryableSendError(new Error('HTTP 409: {"name":"invalid_idempotent_request"}')));
});

test('payload hash is appended to the key', () => {
  assert.equal(buildIdempotencyKey('opening-digest', '2026-10-23', 'a@b.com', 'abc123'), 'opening-digest/2026-10-23/a@b.com/abc123');
});

test('every attempt receives its attempt index and the caller can reuse one key', async () => {
  const keys = [];
  const key = buildIdempotencyKey('p', 'd', 'r', 'h');
  await sendWithRetry(async (i) => { keys.push(key); if (i < 2) throw new Error('Resend request timed out after 15s'); return {}; }, noSleep);
  assert.deepEqual(new Set(keys).size, 1);
  assert.equal(keys.length, 3);
});
