import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isClosedShowEligibleForBatchDiscovery, REGIONAL_RETRY_WINDOW_DAYS } = require('./discovery-eligibility.js');

const NOW = new Date('2026-08-15T12:00:00Z').getTime();

test('open show → always eligible regardless of category', () => {
  assert.equal(isClosedShowEligibleForBatchDiscovery({ status: 'open', category: 'broadway' }, NOW), true);
  assert.equal(isClosedShowEligibleForBatchDiscovery({ status: 'open', category: 'regional' }, NOW), true);
});

test('closed non-regional show → excluded', () => {
  assert.equal(isClosedShowEligibleForBatchDiscovery({ status: 'closed', category: 'broadway' }, NOW), false);
  assert.equal(isClosedShowEligibleForBatchDiscovery({ status: 'closed', category: 'off-broadway' }, NOW), false);
});

test('closed regional show within retry window → eligible', () => {
  const closingDate = new Date(NOW - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  assert.equal(isClosedShowEligibleForBatchDiscovery({ status: 'closed', category: 'regional', closingDate }, NOW), true);
});

test('closed regional show past retry window → excluded (ages out like everyone else)', () => {
  const closingDate = new Date(NOW - (REGIONAL_RETRY_WINDOW_DAYS + 10) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  assert.equal(isClosedShowEligibleForBatchDiscovery({ status: 'closed', category: 'regional', closingDate }, NOW), false);
});

test('closed regional show just inside the window → still eligible', () => {
  const closingDate = new Date(NOW - (REGIONAL_RETRY_WINDOW_DAYS - 1) * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  assert.equal(isClosedShowEligibleForBatchDiscovery({ status: 'closed', category: 'regional', closingDate }, NOW), true);
});

test('closed regional show with no closingDate on record → eligible (unknown treated as recent)', () => {
  assert.equal(isClosedShowEligibleForBatchDiscovery({ status: 'closed', category: 'regional', closingDate: null }, NOW), true);
});

test('closed regional show with unparseable closingDate → eligible (fails safe)', () => {
  assert.equal(isClosedShowEligibleForBatchDiscovery({ status: 'closed', category: 'regional', closingDate: 'not-a-date' }, NOW), true);
});

test('missing show → treated as eligible (fail open, matches prior behavior for malformed input)', () => {
  assert.equal(isClosedShowEligibleForBatchDiscovery(null, NOW), true);
});
