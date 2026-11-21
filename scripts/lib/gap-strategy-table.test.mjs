// BRO-7997: subscriber outlets never get the paid scraper while the logged-in browser can run,
// and a subscriber read settles what the other routes would only guess at.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const T = require('./gap-strategy-table.js');
const PO = require('./gap-plan-order.js');

const sel = (o) => T.selectStrategy({ hasUrl: true, hasAdapter: true, ...o });
const chain = (r) => [r.strategy, ...r.skipped.map((k) => `${k.strategy}:${k.reason}`)];

test('adapter outlet with a usable browser: PAID_FETCH is skipped as paid-blind', () => {
  const r = sel({ gapClass: 'PAYWALL_PAGE', eligible: (s) => (s === 'BROWSER_SESSION' || s === 'ARCHIVE' || s === 'REFETCH_FREE' ? { ok: false, reason: 'cooldown' } : { ok: true, reason: 'ok' }) });
  assert.notEqual(r.strategy, 'PAID_FETCH');
  assert.ok(r.skipped.some((k) => k.strategy === 'PAID_FETCH' && k.reason === 'subscriber_outlet_paid_blind'), JSON.stringify(r.skipped));
});

test('adapter outlet: paid stays the fallback when the browser route is unusable (run gate / flag)', () => {
  const only = (s) => (s === 'PAID_FETCH' ? { ok: true, reason: 'ok' } : { ok: false, reason: 'cooldown' });
  const gated = sel({ gapClass: 'PAYWALL_PAGE', eligible: only, runGates: { BROWSER_SESSION: { ok: false, reason: 'browser_unavailable:no_gui' } } });
  assert.equal(gated.strategy, 'PAID_FETCH');
  const off = sel({ gapClass: 'PAYWALL_PAGE', eligible: only, flags: { ...T.STRATEGY_FLAGS, BROWSER_SESSION: { ...T.STRATEGY_FLAGS.BROWSER_SESSION, enabled: false } } });
  assert.equal(off.strategy, 'PAID_FETCH');
});

test('non-adapter outlet keeps PAID_FETCH; explicit --strategy=PAID_FETCH passes', () => {
  const only = (s) => (s === 'PAID_FETCH' ? { ok: true, reason: 'ok' } : { ok: false, reason: 'cooldown' });
  assert.equal(sel({ gapClass: 'PAYWALL_PAGE', hasAdapter: false, eligible: only }).strategy, 'PAID_FETCH');
  assert.equal(sel({ gapClass: 'PAYWALL_PAGE', eligible: only, only: 'PAID_FETCH' }).strategy, 'PAID_FETCH');
});

test('nightly-off adapter outlet (wsj, sunday-times): no browser planned unattended, paid still blocked', () => {
  const r = sel({ gapClass: 'PAYWALL_PAGE', hasAdapter: false, hasAnyAdapter: true, eligible: (s) => (s === 'PAID_FETCH' ? { ok: true, reason: 'ok' } : { ok: false, reason: 'cooldown' }) });
  assert.equal(r.strategy, null);
  assert.ok(r.skipped.some((k) => k.strategy === 'PAID_FETCH' && k.reason === 'subscriber_outlet_paid_blind'));
});

test('URL_WRONG_PAGE on an adapter outlet tries the browser before the free refetch', () => {
  const r = sel({ gapClass: 'URL_WRONG_PAGE' });
  assert.equal(r.strategy, 'BROWSER_SESSION', chain(r).join(' | '));
  // browser spent: free refetch next, paid never
  const next = sel({ gapClass: 'URL_WRONG_PAGE', eligible: (s) => (s === 'BROWSER_SESSION' ? { ok: false, reason: 'retry_backoff' } : { ok: true, reason: 'ok' }) });
  assert.equal(next.strategy, 'REFETCH_FREE');
});

test('wrong stored url (names another show): URL_FIND, never paid; browser then runs on the found url', () => {
  const r = sel({ gapClass: 'URL_WRONG_PAGE', storedUrlOk: { ok: false, reason: 'url_names_other_show' }, eligible: () => ({ ok: true, reason: 'ok' }) });
  assert.equal(r.strategy, 'URL_FIND', chain(r).join(' | '));
  assert.ok(!r.skipped.some((k) => k.strategy === 'PAID_FETCH' && k.reason === 'subscriber_outlet_paid_blind'), 'paid skipped for url reasons, not by the browser rule being consulted first');
});

// ---- subscriber-read proof (ledger-driven) ----
const stored = 'The stored article text. '.repeat(100);
const url = 'https://www.thetimes.com/culture/theatre-dance/article/x';
const row = (o) => ({ ts: '2026-11-21T10:00:00Z', strategy: 'BROWSER_SESSION', outcome: 'rejected', url, ...o });

test('equal-length not_longer from the browser proves the stored text complete', () => {
  const detail = PO.subscriberReadDetail({ code: 'not_longer', reason: 'not longer than existing (2455 >= 2455)', storedText: stored });
  assert.equal(detail.equalToStored, true);
  assert.equal(PO.subscriberReadProof([row({ reason: 'not_longer', detail })], { reviewUrl: url, storedText: stored }).kind, 'complete');
});

test('a longer stored text (browser was shorter) or changed stored text is no proof', () => {
  const shorter = PO.subscriberReadDetail({ code: 'not_longer', reason: 'not longer than existing (2455 >= 2000)', storedText: stored });
  assert.equal(shorter.equalToStored, undefined);
  assert.equal(PO.subscriberReadProof([row({ reason: 'not_longer', detail: shorter })], { reviewUrl: url, storedText: stored }).kind, null);
  const eq = PO.subscriberReadDetail({ code: 'not_longer', reason: '(10 >= 10)', storedText: stored });
  assert.equal(PO.subscriberReadProof([row({ reason: 'not_longer', detail: eq })], { reviewUrl: url, storedText: stored + ' edited' }).kind, null);
  assert.equal(PO.subscriberReadProof([row({ reason: 'not_longer', detail: eq })], { reviewUrl: url + '-new-article', storedText: stored }).kind, null);
});

test('browser show_not_mentioned at the stored url = wrong page; a later url change voids it', () => {
  assert.equal(PO.subscriberReadProof([row({ reason: 'show_not_mentioned' })], { reviewUrl: url, storedText: stored }).kind, 'wrong_page');
  assert.equal(PO.subscriberReadProof([row({ reason: 'show_not_mentioned' })], { reviewUrl: 'https://www.thetimes.com/culture/other-article-abc', storedText: stored }).kind, null);
  assert.equal(PO.subscriberReadProof([row({ strategy: 'REFETCH_FREE', reason: 'show_not_mentioned' })], { reviewUrl: url, storedText: stored }).kind, null);
});

test('the driver wires the subscriber-read proof and records its detail (guards against unwiring)', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../gap-recovery-driver.js', import.meta.url), 'utf8');
  assert.match(src, /PO\.subscriberReadProof\(/);
  assert.match(src, /subscriber_read_complete/);
  assert.match(src, /PO\.subscriberReadDetail\(/);
});
