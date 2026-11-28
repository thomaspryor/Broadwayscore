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

test('collector-written reason on a verified review is kept', () => {
  const review = { ...base, manuallyVerified: true, manualVerifiedAt: '2026-09-05T15:00:00Z',
    incompleteReason: 'non_review', incompleteDetail: 'human said so' };
  assert.deepEqual(classifyIncompleteReason(review, garbage),
    { incompleteReason: 'non_review', incompleteDetail: 'human said so' });
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

test('real-world shape: manualClearAt + stale machine scraper_garbage is cleared', () => {
  const review = { ...base, textFetchedAt: '2026-08-02T16:03:00Z', manuallyVerified: true,
    manualClearAt: '2026-08-03T00:29:00Z', incompleteReason: 'scraper_garbage', incompleteDetail: 'x' };
  assert.equal(classifyIncompleteReason(review, garbage), null);
});

test('date-only manualVerificationDate on the fetch day protects', () => {
  const review = { ...base, textFetchedAt: '2026-09-09T05:12:00Z', manuallyVerified: true, manualVerificationDate: '2026-09-09' };
  assert.equal(classifyIncompleteReason(review, garbage), null);
});

test('missing textFetchedAt counts as older; unparseable timestamp does not protect', () => {
  assert.equal(isManuallyVerifiedAfterFetch({ manuallyVerified: true, manualVerifiedAt: '2026-09-05T15:00:00Z' }), true);
  assert.equal(isManuallyVerifiedAfterFetch({ manuallyVerified: true, manualVerifiedAt: 'garbage', textFetchedAt: '2026-09-05T15:00:00Z' }), false);
});

test('wrong-content flag on a verified review still yields wrong_content', () => {
  const review = { ...base, manuallyVerified: true, manualVerifiedAt: '2026-09-05T15:00:00Z', wrongProduction: true };
  assert.equal(classifyIncompleteReason(review, null).incompleteReason, 'wrong_content');
});

test('stale wrong_content with flags cleared is dropped on a verified review', () => {
  const review = { ...base, manuallyVerified: true, manualVerifiedAt: '2026-09-05T15:00:00Z', incompleteReason: 'wrong_content' };
  assert.equal(classifyIncompleteReason(review, null), null);
});

test('url_dead still surfaces on a verified review', () => {
  const review = { ...base, manuallyVerified: true, manualVerifiedAt: '2026-09-05T15:00:00Z' };
  const r = classifyIncompleteReason(review, { failureReason: 'url_dead_404', failureCount: 3 });
  assert.equal(r.incompleteReason, 'url_dead');
});

test('BRO-4317: a wrongShow flag cleared by wrongShowManualClear/Override is not wrong content', () => {
  assert.notEqual(classifyIncompleteReason({ ...base, wrongShow: true, wrongShowManualClear: true }, null)?.incompleteReason, 'wrong_content');
  assert.notEqual(classifyIncompleteReason({ ...base, wrongShow: true, wrongShowOverride: true }, null)?.incompleteReason, 'wrong_content');
  assert.equal(classifyIncompleteReason({ ...base, wrongShow: true }, null).incompleteReason, 'wrong_content');
  assert.equal(classifyIncompleteReason({ ...base, wrongShow: true, wrongShowManualClear: true, wrongProduction: true }, null).incompleteReason, 'wrong_content');
});

// BRO-5261 retro-review of BRO-2241: the collector re-derives the reason the
// way rebuild does, so a null classifier result removes a stale one.
const { applyIncompleteReason } = require('./incomplete-reason.js');

test('applyIncompleteReason sets a fresh reason', () => {
  const d = { ...base };
  const r = applyIncompleteReason(d, garbage);
  assert.equal(r.incompleteReason, 'scraper_garbage');
  assert.equal(d.incompleteReason, 'scraper_garbage');
  assert.equal(d.incompleteDetail, 'cookie wall');
});

test('applyIncompleteReason removes a stale reason when the classifier gives none', () => {
  // A manual verification newer than the fetch makes the classifier return null.
  const d = { ...base, manuallyVerified: true, manualVerifiedAt: '2026-09-06T00:00:00Z', incompleteReason: 'paywall', incompleteDetail: 'old' };
  assert.equal(applyIncompleteReason(d, null), null);
  assert.equal('incompleteReason' in d, false);
  assert.equal('incompleteDetail' in d, false);
});

test('applyIncompleteReason keeps a collector reason a manual verification preserves', () => {
  const d = { ...base, manuallyVerified: true, manualVerifiedAt: '2026-09-06T00:00:00Z', incompleteReason: 'non_review', incompleteDetail: 'x' };
  applyIncompleteReason(d, null);
  assert.equal(d.incompleteReason, 'non_review');
});
