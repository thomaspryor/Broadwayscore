/**
 * Unit tests for scripts/lib/consent-refetch.js — the consent-backlog auto-drain
 * decision. Lets a wrongShow/wrongProduction review whose STORED text is garbage
 * (empty/consent-wall) re-fetch once the consent-dismissing scraper landed,
 * cooldown-gated. Must NEVER match a flag on a review with real buried text.
 *
 * Run: node --test tests/unit/consent-refetch.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { shouldRetryGarbageConsentWall, REFETCH_COOLDOWN_MS } = require('../../scripts/lib/consent-refetch');

const NOW = 1_750_000_000_000;

describe('shouldRetryGarbageConsentWall', () => {
  it('retries when stored text is garbage and never retried before', () => {
    assert.strictEqual(
      shouldRetryGarbageConsentWall({ hasGarbageStoredText: true, lastRetryMs: null, nowMs: NOW }),
      true
    );
  });

  it('does NOT retry when stored text is NOT garbage (real buried review)', () => {
    // helen-shaw case: newsletter prefix + real review → isGarbage=false → leave it.
    assert.strictEqual(
      shouldRetryGarbageConsentWall({ hasGarbageStoredText: false, lastRetryMs: null, nowMs: NOW }),
      false
    );
  });

  it('respects the cooldown: no retry within 14 days of the last attempt', () => {
    const oneDayAgo = NOW - 24 * 60 * 60 * 1000;
    assert.strictEqual(
      shouldRetryGarbageConsentWall({ hasGarbageStoredText: true, lastRetryMs: oneDayAgo, nowMs: NOW }),
      false
    );
  });

  it('retries again after the cooldown elapses', () => {
    const longAgo = NOW - (REFETCH_COOLDOWN_MS + 1000);
    assert.strictEqual(
      shouldRetryGarbageConsentWall({ hasGarbageStoredText: true, lastRetryMs: longAgo, nowMs: NOW }),
      true
    );
  });

  it('returns false on bad/missing nowMs (defensive)', () => {
    assert.strictEqual(
      shouldRetryGarbageConsentWall({ hasGarbageStoredText: true, lastRetryMs: null, nowMs: undefined }),
      false
    );
  });

  it('returns false on empty ctx', () => {
    assert.strictEqual(shouldRetryGarbageConsentWall(), false);
    assert.strictEqual(shouldRetryGarbageConsentWall({}), false);
  });
});
