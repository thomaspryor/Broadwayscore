// scripts/lib/tier-attempt-stats.test.mjs — node:test
// Run: node --test scripts/lib/tier-attempt-stats.test.mjs
//
// BRO-4334: partial text counts as failure for tier ORDERING, success for the
// dead-end SKIP list. Imports the real functions (CLAUDE.md §15).

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { tallyFileAttempts, toSkipStats, winningAttemptIndex } from './tier-attempt-stats.js';

const norm = (method) => method;

test('flagged partial attempt: failure for ordering, tracked as partial', () => {
  const stats = {};
  const data = {
    contentTier: 'complete',
    fetchMethod: 'browserbase',
    fetchAttempts: [
      { tier: 2, method: 'scrapingbee', success: false, partial: true },
      { tier: 1.5, method: 'browserbase', success: true },
    ],
  };
  assert.equal(tallyFileAttempts(stats, 'nytimes.com', data, norm), true);
  assert.deepEqual(stats['nytimes.com'].scrapingbee, { successes: 0, failures: 1, partials: 1 });
  assert.deepEqual(stats['nytimes.com'].browserbase, { successes: 1, failures: 0, partials: 0 });
});

test('retroactive: truncated file\'s winning attempt counts as partial', () => {
  const stats = {};
  const data = {
    contentTier: 'truncated',
    fetchMethod: 'scrapingbee',
    fetchAttempts: [
      { tier: 0, method: 'archive-first', success: false },
      { tier: 2, method: 'scrapingbee', success: true },
    ],
  };
  tallyFileAttempts(stats, 'nytimes.com', data, norm);
  assert.deepEqual(stats['nytimes.com'].scrapingbee, { successes: 0, failures: 1, partials: 1 });
  assert.deepEqual(stats['nytimes.com']['archive-first'], { successes: 0, failures: 1, partials: 0 });
});

test('retroactive rule needs the winner to be the stored text\'s method', () => {
  const stats = {};
  // stored text later came from a different source (manual) — don't blame scrapingbee
  tallyFileAttempts(stats, 'nytimes.com', {
    contentTier: 'truncated',
    fetchMethod: 'manual-entry',
    fetchAttempts: [{ tier: 2, method: 'scrapingbee', success: true }],
  }, norm);
  assert.deepEqual(stats['nytimes.com'].scrapingbee, { successes: 1, failures: 0, partials: 0 });
});

test('complete file: unchanged legacy tally', () => {
  const stats = {};
  tallyFileAttempts(stats, 'x.com', {
    contentTier: 'complete',
    fetchMethod: 'scrapingbee',
    fetchAttempts: [{ tier: 1, method: 'playwright', success: false }, { tier: 2, method: 'scrapingbee', success: true }],
  }, norm);
  assert.deepEqual(stats['x.com'].playwright, { successes: 0, failures: 1, partials: 0 });
  assert.deepEqual(stats['x.com'].scrapingbee, { successes: 1, failures: 0, partials: 0 });
});

test('no attempts → false, stats untouched', () => {
  const stats = {};
  assert.equal(tallyFileAttempts(stats, 'x.com', { fetchAttempts: [] }, norm), false);
  assert.equal(tallyFileAttempts(stats, 'x.com', {}, norm), false);
  assert.deepEqual(stats, {});
});

test('winningAttemptIndex: last success (garbage tiers log success before continuing)', () => {
  assert.equal(winningAttemptIndex({ fetchAttempts: [{ success: true }, { success: false }, { success: true }, { success: false }] }), 2);
  assert.equal(winningAttemptIndex({ fetchAttempts: [{ success: false }] }), -1);
});

test('toSkipStats: partials count as successes so partial-only tiers are never skip-listed', () => {
  const skip = toSkipStats({ 'nytimes.com': { scrapingbee: { successes: 0, failures: 5, partials: 5 }, playwright: { successes: 0, failures: 4, partials: 0 } } });
  assert.deepEqual(skip['nytimes.com'].scrapingbee, { successes: 5, failures: 0 });
  assert.deepEqual(skip['nytimes.com'].playwright, { successes: 0, failures: 4 });
});
