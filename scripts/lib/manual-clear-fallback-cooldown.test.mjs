import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isInFallbackCooldown, COOLDOWN_MS, MAX_BACKOFF_MS } = require('./manual-clear-fallback-cooldown.js');

const NOW = new Date('2026-07-26T12:00:00Z').getTime();

test('no failure recorded → not in cooldown', () => {
  assert.equal(isInFallbackCooldown({}, NOW), false);
  assert.equal(isInFallbackCooldown(null, NOW), false);
});

test('recent failure (1st attempt) → in cooldown for 24h', () => {
  const failedAt = new Date(NOW - 60 * 60 * 1000).toISOString(); // 1h ago
  assert.equal(isInFallbackCooldown({ manualClearFallbackFailedAt: failedAt, manualClearFallbackAttempts: 1 }, NOW), true);
});

test('failure past the 24h window (1st attempt) → cooldown elapsed', () => {
  const failedAt = new Date(NOW - COOLDOWN_MS - 1000).toISOString();
  assert.equal(isInFallbackCooldown({ manualClearFallbackFailedAt: failedAt, manualClearFallbackAttempts: 1 }, NOW), false);
});

test('repeated failures back off further (3rd attempt still cooling at 24h)', () => {
  const failedAt = new Date(NOW - COOLDOWN_MS - 1000).toISOString(); // >24h ago
  // 3 attempts → 72h backoff, so still cooling despite being past the base 24h window.
  assert.equal(isInFallbackCooldown({ manualClearFallbackFailedAt: failedAt, manualClearFallbackAttempts: 3 }, NOW), true);
});

test('backoff caps at MAX_BACKOFF_MS regardless of attempt count', () => {
  const failedAt = new Date(NOW - MAX_BACKOFF_MS - 1000).toISOString();
  assert.equal(isInFallbackCooldown({ manualClearFallbackFailedAt: failedAt, manualClearFallbackAttempts: 999 }, NOW), false);
});

test('malformed timestamp is treated as not in cooldown (fail open)', () => {
  assert.equal(isInFallbackCooldown({ manualClearFallbackFailedAt: 'not-a-date' }, NOW), false);
});
