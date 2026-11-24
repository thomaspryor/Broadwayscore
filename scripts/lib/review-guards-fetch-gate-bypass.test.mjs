// BRO-3319: show-filtered collect-review-texts runs must honour the
// fetch-retry cooldown outside the opening window.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { shouldBypassFetchGate, isFetchLedgerEntryForOtherUrl, shouldRetryFetch } = require('./review-guards.js');

const DAY = 864e5;
const iso = (ms) => new Date(Date.now() + ms).toISOString().slice(0, 10);
const openWindowShow = { status: 'open', openingDate: iso(-5 * DAY), category: 'broadway' };
const previewsShow = { status: 'previews', openingDate: iso(5 * DAY) };
const openMatureShow = { status: 'open', openingDate: iso(-400 * DAY), category: 'broadway' };
const closedOldShow = { status: 'closed', closingDate: iso(-900 * DAY) };

test('explicit per-file targeting always bypasses', () => {
  assert.equal(shouldBypassFetchGate({ reviewTargeted: true, showFilterActive: false, show: closedOldShow }), true);
});

const { isFetchHotWindow, isPressNight, shouldRetryBbInsufficientText, recordFetchAttempt } = require('./review-guards.js');
const base = { reviewTargeted: false, showFilterActive: true };
const pressNightShow = { status: 'open', openingDate: iso(-1.5 * DAY), category: 'broadway' }; // 10-34h after the 9pm-ET publication, whatever the time of day

test('show filter waives abandonment only in the hot window, never cooldown', () => {
  // BRO-6867 class guard: an openWindow show 3 days past opening (outside the 48h press night)
  // with an abandoned review must stay gated under a show filter (the poller "auto" shape).
  assert.equal(shouldBypassFetchGate({ ...base, show: openWindowShow, gateReason: 'max_retries_reached' }), false);
  assert.equal(shouldBypassFetchGate({ ...base, show: openWindowShow, gateReason: 'cooldown' }), false);
  assert.equal(shouldBypassFetchGate({ ...base, show: pressNightShow, gateReason: 'max_retries_reached' }), true);
  assert.equal(shouldBypassFetchGate({ ...base, show: pressNightShow, gateReason: 'cooldown', fetchRetryAfter: new Date(Date.now() + 1800e3).toISOString() }), false);
  const future = new Date(Date.now() + 3600e3).toISOString();
  assert.equal(shouldBypassFetchGate({ ...base, show: pressNightShow, gateReason: 'max_retries_reached', fetchRetryAfter: future }), false);
  assert.equal(shouldBypassFetchGate({ ...base, show: pressNightShow, gateReason: 'max_retries_reached', fetchRetryAfter: new Date(Date.now() - 1000).toISOString() }), true);
});

test('mature / closed / unknown shows never bypass', () => {
  for (const show of [openMatureShow, closedOldShow, { status: 'announced' }, null]) {
    assert.equal(shouldBypassFetchGate({ ...base, show, gateReason: 'max_retries_reached' }), false);
  }
});

test('explicit per-file targeting always bypasses; unfiltered runs never do', () => {
  assert.equal(shouldBypassFetchGate({ reviewTargeted: true, showFilterActive: false, show: closedOldShow }), true);
  assert.equal(shouldBypassFetchGate({ reviewTargeted: false, showFilterActive: false, show: pressNightShow, gateReason: 'max_retries_reached' }), false);
});

test('hot window shares one definition with recordFetchAttempt (press night)', () => {
  assert.equal(isFetchHotWindow(pressNightShow), true);
  assert.equal(isPressNight(pressNightShow), true);
  assert.equal(isFetchHotWindow(openWindowShow), false);
  const rec = recordFetchAttempt(pressNightShow, {}, { failureReason: 'all_tiers_failed', failureCount: 20 });
  assert.equal(rec.fetchDiscoveryAbandoned, undefined, 'press night never abandons');
  assert.ok(rec.fetchRetryAfter);
  assert.equal(rec.fetchPrePubFailures, 1, 'hot-window failures are not charged to the post-window budget');
});

test('soft-404 in the hot window retries within the hour; outside it keeps the long ladder', () => {
  const fail = { failureReason: 'soft_404', failureCount: 1 };
  const hot = recordFetchAttempt(pressNightShow, {}, fail);
  assert.ok(new Date(hot.fetchRetryAfter).getTime() - Date.now() <= 3600e3 + 1000);
  const cold = recordFetchAttempt(openWindowShow, {}, fail);
  assert.ok(new Date(cold.fetchRetryAfter).getTime() - Date.now() >= 2.9 * 3600e3);
});

test('a long soft-404 wait stamped before the window does not hold back a hot-window retry', () => {
  const long = new Date(Date.now() + 12 * 3600e3).toISOString();
  const short = new Date(Date.now() + 1800e3).toISOString();
  assert.equal(shouldBypassFetchGate({ ...base, show: pressNightShow, gateReason: 'cooldown', fetchRetryAfter: long }), true, 'pre-window soft-404 wait (reason is cooldown) is overridden');
  assert.equal(shouldBypassFetchGate({ ...base, show: pressNightShow, gateReason: 'max_retries_reached', fetchRetryAfter: long }), true);
  assert.equal(shouldBypassFetchGate({ ...base, show: pressNightShow, gateReason: 'max_retries_reached', fetchRetryAfter: short }), false);
});

test('fresh-session retry is skipped on HTTP 401/403/404/410, kept for 200-empty flake', () => {
  const mk = (httpStatus) => Object.assign(new Error('Insufficient text: 0 chars'), { httpStatus });
  for (const st of [401, 403, 404, 410]) assert.equal(shouldRetryBbInsufficientText(mk(st)), false);
  assert.equal(shouldRetryBbInsufficientText(mk(200)), true);
  assert.equal(shouldRetryBbInsufficientText(mk(undefined)), true);
  assert.equal(shouldRetryBbInsufficientText(new Error('cap reached')), false);
});

test('browserbase ledger rows carry a query-stripped url, other providers do not', async (t) => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { makeTmpDir } = require('./tmpdir-for-tests.js');
  const file = path.join(makeTmpDir(t, 'bbledger-'), 'ledger.jsonl');
  const prev = process.env.SCRAPER_SPEND_LEDGER_PATH;
  process.env.SCRAPER_SPEND_LEDGER_PATH = file;
  const { recordBbCall, recordProviderCall } = require('./provider-telemetry.js');
  const origLog = console.log; console.log = () => {};
  try {
    recordBbCall({ caller: 't', host: 'nytimes.com', url: 'https://www.nytimes.com/2026/11/20/theater/x.html?unlock=SECRET#frag', success: true });
    recordProviderCall({ provider: 'brightdata', fn: 'fetch', caller: 't', url: 'https://a.com/p?q=1', success: true });
  } finally { console.log = origLog; if (prev === undefined) delete process.env.SCRAPER_SPEND_LEDGER_PATH; else process.env.SCRAPER_SPEND_LEDGER_PATH = prev; }
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const bb = rows.find((r) => r.provider === 'browserbase');
  assert.equal(bb.url, 'https://www.nytimes.com/2026/11/20/theater/x.html');
  assert.equal(rows.find((r) => r.provider === 'brightdata').url, undefined);
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
