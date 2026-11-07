// BRO-3319: show-filtered collect-review-texts runs must honour the
// fetch-retry cooldown outside the opening window.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { shouldBypassFetchGate, isFetchLedgerEntryForOtherUrl, shouldRetryFetch } = require('./review-guards.js');

const DAY = 864e5;
const iso = (ms) => new Date(Date.now() + ms).toISOString().slice(0, 10);
const openWindowShow = { status: 'open', openingDate: iso(-3 * DAY), category: 'broadway' };
const previewsShow = { status: 'previews', openingDate: iso(5 * DAY) };
const openMatureShow = { status: 'open', openingDate: iso(-400 * DAY), category: 'broadway' };
const closedOldShow = { status: 'closed', closingDate: iso(-900 * DAY) };

test('explicit per-file targeting always bypasses', () => {
  assert.equal(shouldBypassFetchGate({ reviewTargeted: true, showFilterActive: false, show: closedOldShow }), true);
});

test('show filter bypasses only in previews / opening window', () => {
  assert.equal(shouldBypassFetchGate({ reviewTargeted: false, showFilterActive: true, show: openWindowShow }), true);
  assert.equal(shouldBypassFetchGate({ reviewTargeted: false, showFilterActive: true, show: previewsShow }), true);
  assert.equal(shouldBypassFetchGate({ reviewTargeted: false, showFilterActive: true, show: openMatureShow }), false);
  assert.equal(shouldBypassFetchGate({ reviewTargeted: false, showFilterActive: true, show: closedOldShow }), false);
});

test('unknown lifecycle and missing show do not bypass', () => {
  assert.equal(shouldBypassFetchGate({ reviewTargeted: false, showFilterActive: true, show: { status: 'announced' } }), false);
  assert.equal(shouldBypassFetchGate({ reviewTargeted: false, showFilterActive: true, show: null }), false);
});

test('unfiltered run never bypasses', () => {
  assert.equal(shouldBypassFetchGate({ reviewTargeted: false, showFilterActive: false, show: openWindowShow }), false);
});

test('mature show in cooldown stays gated under a show filter (the BRO-3319 repeat)', () => {
  const review = { fetchRetryAfter: new Date(Date.now() + 2 * 3600e3).toISOString() };
  const gate = shouldRetryFetch(openMatureShow, review, { failureReason: 'all_tiers_failed', failureCount: 1 });
  assert.equal(gate.shouldRetry, false);
  assert.equal(gate.shouldRetry || shouldBypassFetchGate({ reviewTargeted: false, showFilterActive: true, show: openMatureShow }), false);
});

test('ledger entry is stale only when the file URL changed after the failure', () => {
  const failed = { url: 'https://a.com/old-review', lastFailedAt: '2026-10-01T00:00:00Z' };
  // URL replaced after the failure: the old failures do not gate the new URL.
  assert.equal(isFetchLedgerEntryForOtherUrl(failed, { url: 'https://a.com/new-review', urlDiscoveredAt: '2026-10-02T00:00:00Z' }), true);
  assert.equal(isFetchLedgerEntryForOtherUrl(failed, { url: 'https://a.com/new-review', urlUpdatedAt: '2026-10-02T00:00:00Z' }), true);
  // Ledger URL was a SERP candidate never saved to the file (no newer stamp):
  // the gate must keep applying, or the review is refetched every run forever.
  assert.equal(isFetchLedgerEntryForOtherUrl(failed, { url: 'https://a.com/new-review' }), false);
  assert.equal(isFetchLedgerEntryForOtherUrl(failed, { url: 'https://a.com/new-review', urlDiscoveredAt: '2026-09-01T00:00:00Z' }), false);
  // Same URL after normalization, missing fields.
  assert.equal(isFetchLedgerEntryForOtherUrl({ url: 'https://www.a.com/review/', lastFailedAt: '2026-10-01T00:00:00Z' }, { url: 'https://a.com/review', urlDiscoveredAt: '2026-10-02T00:00:00Z' }), false);
  assert.equal(isFetchLedgerEntryForOtherUrl({ url: 'https://a.com/old-review' }, { url: 'https://a.com/new-review', urlDiscoveredAt: '2026-10-02T00:00:00Z' }), false);
  assert.equal(isFetchLedgerEntryForOtherUrl({ url: null, lastFailedAt: '2026-10-01T00:00:00Z' }, { url: 'https://a.com/x' }), false);
  assert.equal(isFetchLedgerEntryForOtherUrl(null, { url: 'https://a.com/x' }), false);
  assert.equal(isFetchLedgerEntryForOtherUrl(failed, { url: '' }), false);
});
