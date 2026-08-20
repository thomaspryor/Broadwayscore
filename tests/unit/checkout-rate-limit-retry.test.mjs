// tests/unit/checkout-rate-limit-retry.test.mjs — BRO-66 acceptance test.
// Verifies scripts/lib/github-rate-limit-retry.js's backoff timing and
// retry/give-up decisions against mocked 403 rate-limit responses, per the
// card's "unit-tested with mock 403 responses to verify backoff timing and
// success after retry" criterion.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isRateLimitError,
  retryDelayMs,
  shouldRetry,
  MAX_DELAY_MS,
  DEFAULT_BASE_MS,
  DEFAULT_MAX_ATTEMPTS,
} from '../../scripts/lib/github-rate-limit-retry.js';

const RATE_LIMIT_403 =
  "fatal: unable to access 'https://github.com/thomaspryor/broadway-review-texts.git/': " +
  'The requested URL returned error: 403\n' +
  'API rate limit exceeded for user ID 3475675 (or one of its API partners).';

test('isRateLimitError matches the exact BRO-66 incident message', () => {
  assert.equal(isRateLimitError(RATE_LIMIT_403), true);
});

test('isRateLimitError matches secondary rate limit wording', () => {
  assert.equal(isRateLimitError('You have exceeded a secondary rate limit'), true);
});

test('isRateLimitError is false for unrelated git failures', () => {
  assert.equal(isRateLimitError('fatal: could not read Username for https://github.com'), false);
  assert.equal(isRateLimitError(''), false);
  assert.equal(isRateLimitError(undefined), false);
});

test('shouldRetry retries a rate-limited attempt under the max', () => {
  const result = shouldRetry({ attempt: 1, exitCode: 128, stderr: RATE_LIMIT_403 });
  assert.equal(result.retry, true);
  assert.equal(result.reason, 'rate-limited');
});

test('shouldRetry gives up once max attempts is reached (success after retry stops there)', () => {
  const result = shouldRetry({
    attempt: DEFAULT_MAX_ATTEMPTS,
    exitCode: 128,
    stderr: RATE_LIMIT_403,
  });
  assert.equal(result.retry, false);
  assert.equal(result.reason, 'max-attempts-reached');
});

test('shouldRetry never retries a non-rate-limit failure', () => {
  const result = shouldRetry({ attempt: 1, exitCode: 128, stderr: 'fatal: repository not found' });
  assert.equal(result.retry, false);
  assert.equal(result.reason, 'not-rate-limit');
});

test('shouldRetry treats exitCode 0 as success regardless of stderr', () => {
  const result = shouldRetry({ attempt: 1, exitCode: 0, stderr: RATE_LIMIT_403 });
  assert.equal(result.retry, false);
  assert.equal(result.reason, 'success');
});

test('shouldRetry honors a caller-supplied maxAttempts', () => {
  const result = shouldRetry({ attempt: 1, exitCode: 128, stderr: RATE_LIMIT_403, maxAttempts: 1 });
  assert.equal(result.retry, false);
  assert.equal(result.reason, 'max-attempts-reached');
});

test('retryDelayMs backs off exponentially from the 30s base', () => {
  // random=0 → lower bound of the jitter window (0.5x of the exponential term)
  const attempt1Low = retryDelayMs(1, { random: () => 0 });
  const attempt1High = retryDelayMs(1, { random: () => 1 });
  assert.equal(attempt1Low, Math.round(DEFAULT_BASE_MS * 0.5));
  assert.equal(attempt1High, DEFAULT_BASE_MS);

  const attempt2Low = retryDelayMs(2, { random: () => 0 });
  const attempt2High = retryDelayMs(2, { random: () => 1 });
  assert.equal(attempt2Low, Math.round(DEFAULT_BASE_MS * 2 * 0.5));
  assert.equal(attempt2High, DEFAULT_BASE_MS * 2);
});

test('retryDelayMs is monotonically non-decreasing with attempt number', () => {
  const d1 = retryDelayMs(1, { random: () => 1 });
  const d2 = retryDelayMs(2, { random: () => 1 });
  const d3 = retryDelayMs(3, { random: () => 1 });
  assert.ok(d2 >= d1);
  assert.ok(d3 >= d2);
});

test('retryDelayMs never exceeds the cap even at high attempt numbers', () => {
  const delay = retryDelayMs(10, { random: () => 1 });
  assert.ok(delay <= MAX_DELAY_MS);
  assert.equal(delay, MAX_DELAY_MS);
});

test('retryDelayMs respects a caller-supplied baseMs/capMs', () => {
  const delay = retryDelayMs(1, { baseMs: 1000, capMs: 500, random: () => 1 });
  assert.equal(delay, 500);
});
