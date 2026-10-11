import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { classifyIncompleteReason, isManuallyVerifiedAfterFetch } = require('./incomplete-reason.js');

const base = {
  contentTier: 'truncated',
  url: 'https://example.com/review',
  fetchMethod: 'scrapingbee',
  textFetchedAt: '2026-09-05T12:54:52Z',
};
const garbage = { failureReason: 'garbage_content', garbageReason: 'cookie wall', failureCount: 2 };

test('unverified review is still classified (control)', () => {
  const r = classifyIncompleteReason({ ...base }, garbage);
  assert.equal(r.incompleteReason, 'scraper_garbage');
});

test('manual clear newer than fetch survives recompute (BRO-2890)', () => {
  const review = { ...base, manuallyVerified: true, manualVerifiedAt: '2026-09-05T15:00:00Z' };
  assert.equal(classifyIncompleteReason(review, garbage), null);
});

test('manual non-null reason is returned unchanged', () => {
  const review = { ...base, manuallyVerified: true, manualVerifiedAt: '2026-09-05T15:00:00Z',
    incompleteReason: 'paywall', incompleteDetail: 'human said so' };
  assert.deepEqual(classifyIncompleteReason(review, garbage),
    { incompleteReason: 'paywall', incompleteDetail: 'human said so' });
});

test('verification older than the latest fetch does not protect', () => {
  const review = { ...base, manuallyVerified: true, manualVerifiedAt: '2026-09-05T10:00:00Z' };
  assert.equal(classifyIncompleteReason(review, garbage).incompleteReason, 'scraper_garbage');
});

test('manuallyVerified without manualVerifiedAt does not protect', () => {
  assert.equal(isManuallyVerifiedAfterFetch({ ...base, manuallyVerified: true }), false);
});

test('url_content_mismatch still surfaces on a verified review', () => {
  const review = { ...base, manuallyVerified: true, manualVerifiedAt: '2026-09-05T15:00:00Z' };
  const r = classifyIncompleteReason(review, { failureReason: 'url_content_mismatch' });
  assert.equal(r.incompleteReason, 'url_content_mismatch');
});
