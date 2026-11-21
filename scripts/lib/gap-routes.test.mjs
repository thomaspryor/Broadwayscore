// BRO-7943 class guard: no gap class may dead-end on a route that exists.
// Requires the real modules; nothing is copied here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const T = require('./gap-strategy-table.js');
const A = require('./browser-outlet-adapters.js');
const G = require('./gap-terminal.js');
const S = require('./scraper.js');
const { MAJOR_FULLTEXT_OUTLETS } = require('./outlet-fulltext.js');

const no = (reason) => ({ ok: false, reason });
const ok = { ok: true, reason: 'ok' };

test('every URL-class order ends in PAID_FETCH when the paid tier is up (no dead end after abandoned refetch)', () => {
  for (const gapClass of ['SHORT_UNVERIFIED', 'TRUNCATED_OTHER', 'PAYWALL_TRUNCATED', 'PAYWALL_PAGE', 'NEVER_FETCHED', 'BLOCKED', 'DEFERRED', 'URL_WRONG_PAGE', 'GARBAGE_PAGE']) {
    // everything else spent/cooling: only PAID_FETCH is eligible
    const r = T.selectStrategy({ gapClass, hasUrl: true, hasAdapter: false, eligible: (s) => (s === 'PAID_FETCH' ? ok : no('abandoned')) });
    assert.equal(r.strategy, 'PAID_FETCH', gapClass);
  }
});

test('paid fetch is skipped (not selected) when the paid tier is unavailable', () => {
  const r = T.selectStrategy({ gapClass: 'TRUNCATED_OTHER', hasUrl: true, hasAdapter: false, paidTierOk: false, eligible: (s) => (s === 'PAID_FETCH' ? ok : no('abandoned')) });
  assert.notEqual(r.strategy, 'PAID_FETCH');
  assert.ok(r.skipped.some((k) => k.strategy === 'PAID_FETCH' && k.reason === 'no_paid_tier'));
});

test('ARCHIVE: minimum show age replaces historicOnly (recent shows 60d+ old get ARCHIVE)', () => {
  assert.equal(T.STRATEGY_FLAGS.ARCHIVE.historicOnly, undefined);
  assert.ok(T.STRATEGY_FLAGS.ARCHIVE.minShowAgeDays >= 30);
  const base = { gapClass: 'TRUNCATED_OTHER', hasUrl: true, hasAdapter: false, recency: 'recent', eligible: (s) => (s === 'ARCHIVE' ? ok : no('abandoned')) };
  assert.equal(T.selectStrategy({ ...base, showAgeDays: 400 }).strategy, 'ARCHIVE');
  const young = T.selectStrategy({ ...base, showAgeDays: 20 });
  assert.notEqual(young.strategy, 'ARCHIVE');
  assert.ok(young.skipped.some((k) => k.strategy === 'ARCHIVE' && k.reason === 'show_too_new'));
  assert.equal(T.selectStrategy({ ...base, showAgeDays: null }).strategy, 'ARCHIVE'); // undated: not taken away
});

test('free sites with a spent free refetch go on to URL_FIND; a cooldown does not', () => {
  const spent = T.selectStrategy({ gapClass: 'TRUNCATED_OTHER', hasUrl: true, hasAdapter: false, paidTierOk: false, showAgeDays: 10, eligible: (s) => (s === 'URL_FIND' ? ok : no('abandoned')) });
  assert.equal(spent.strategy, 'URL_FIND');
  const cooling = T.selectStrategy({ gapClass: 'TRUNCATED_OTHER', hasUrl: true, hasAdapter: false, paidTierOk: false, showAgeDays: 10, eligible: (s) => (s === 'URL_FIND' ? ok : no('cooldown')) });
  assert.equal(cooling.strategy, null);
  assert.ok(cooling.skipped.some((k) => k.strategy === 'URL_FIND' && k.reason === 'refetch_not_spent'));
});

test('Talkin Broadway (Cloudflare managed) has no free tier, so it routes to the paid fetch', () => {
  assert.deepEqual(S.freeTiersForUrl('https://www.talkinbroadway.com/page/2026/x.html'), []);
  assert.ok(S.freeTiersForUrl('https://www.timeout.com/x').some((t) => t.startsWith('playwright')), 'other hosts keep their free tiers');
  const r = T.selectStrategy({ gapClass: 'TRUNCATED_OTHER', hasUrl: true, hasAdapter: false, freeTierOk: false, showAgeDays: 400, eligible: (s) => (s === 'PAID_FETCH' ? ok : no('x')) });
  assert.equal(r.strategy, 'PAID_FETCH');
});

test('class guard: every paywalled major outlet we hold a login for has a browser adapter; FT is nightly-planned', () => {
  for (const outletId of ['wsj', 'times-uk', 'sunday-times', 'financialtimes', 'telegraph']) {
    assert.ok(A.adapterFor(outletId), `${outletId}: no browser adapter (would be no_adapter forever)`);
  }
  // BRO-7943 live pilots 2026-11-21: ft 88%, thetimes 56%, telegraph 50% -> nightly; wsj 25% -> manual only
  for (const o of ['financialtimes', 'times-uk', 'sunday-times', 'telegraph']) assert.equal(A.adapterUsable(o), true, o);
  assert.equal(A.adapterUsable('wsj'), false);
  assert.equal(A.adapterUsable('wsj', { explicitOutlets: ['wsj'] }), true);
});

test('class guard: every login renew-cookies keeps alive has a recovery adapter (a login with no adapter = no_adapter forever)', () => {
  const { RENEW_OUTLETS, profileNameFor } = require('./cookie-renew.js');
  for (const outlet of Object.keys(RENEW_OUTLETS)) {
    const profile = profileNameFor(outlet);
    assert.ok(A.ADAPTERS[profile], `renew-cookies keeps a "${outlet}" login (profile ${profile}) but browser-outlet-adapters has no adapter for it`);
  }
});

test('terminal records re-evaluate when routes change (BRO-7943 item 6)', () => {
  const review = { outletId: 'financialtimes', url: 'https://www.ft.com/content/x' };
  const rec = (extra) => ({ reason: 'PAYWALL_NO_ACCESS', decidedAt: '2026-01-01T00:00:00Z', decidedBy: 'owner', approvedBy: 'owner: ok', evidence: ['REFETCH_FREE: rejected (x)'], urlAtDecision: review.url, policyVersion: G.TERMINAL_POLICY_VERSION, ...extra });
  // fresh record built now is valid for a historic show
  const built = G.buildTerminalRecord({ review, reason: 'PAYWALL_NO_ACCESS', evidence: ['BROWSER_SESSION: rejected (x)'], decidedBy: 'owner', approvedBy: 'owner: ok' });
  assert.equal(G.validateTerminal({ ...review, textUnrecoverable: built }, { recency: 'historic' }).valid, true);
  assert.equal(G.buildTerminalRecord({ review, reason: 'OUTLET_DEFUNCT', evidence: ['dns'], decidedBy: 'gap-terminal-auto' }).routeFingerprint, undefined);
  // config changed under it
  const stale = { ...built, routeFingerprint: 'adapter=none;flags=REFETCH_FREE' };
  assert.deepEqual(G.validateTerminal({ ...review, textUnrecoverable: stale }, { recency: 'historic' }), { valid: false, reason: 'routes_changed' });
  // legacy record for an outlet that now has an adapter it never tried
  assert.equal(G.validateTerminal({ ...review, textUnrecoverable: rec() }, { recency: 'historic' }).reason, 'routes_changed');
  // legacy record for an outlet with no adapter stays valid
  const noad = { outletId: 'broadwayworld', url: 'https://www.broadwayworld.com/x' };
  assert.equal(G.validateTerminal({ ...noad, textUnrecoverable: rec({ urlAtDecision: noad.url }) }, { recency: 'historic' }).valid, true);
});

test('review fixes: URL_FIND runs before PAID_FETCH; URL_DEAD never pays; --strategy=URL_FIND sees a spent refetch', () => {
  // both free routes spent, URL_FIND and PAID_FETCH eligible: the free url search wins
  const r = T.selectStrategy({ gapClass: 'TRUNCATED_OTHER', hasUrl: true, hasAdapter: false, showAgeDays: 400, eligible: (s) => (s === 'URL_FIND' || s === 'PAID_FETCH' ? ok : no('abandoned')) });
  assert.equal(r.strategy, 'URL_FIND');
  // a dead url: everything else spent, PAID_FETCH must not be the route
  const dead = T.selectStrategy({ gapClass: 'URL_DEAD', hasUrl: true, hasAdapter: false, showAgeDays: 400, eligible: (s) => (s === 'PAID_FETCH' ? ok : no('cooldown')) });
  assert.equal(dead.strategy, null);
  assert.ok(!dead.skipped.some((k) => k.strategy === 'PAID_FETCH'));
  // only=URL_FIND never visits REFETCH_FREE, but its spent state still counts
  const only = T.selectStrategy({ gapClass: 'TRUNCATED_OTHER', hasUrl: true, hasAdapter: false, only: 'URL_FIND', eligible: (s) => (s === 'URL_FIND' ? ok : no('abandoned')) });
  assert.equal(only.strategy, 'URL_FIND');
});

test('review fix: opening a second outlet session closes the first (one shared cookie-renew lock)', async () => {
  const log = [];
  const sess = (n) => ({ close: async () => { log.push(n); } });
  const m = new Map([['thestage', sess('thestage')], ['nyt', { failed: { outcome: 'auth_failed' } }], ['ft', sess('ft')]]);
  const closed = await A.closeOtherSessions(m, 'ft');
  assert.deepEqual(closed, ['thestage']);
  assert.deepEqual(log, ['thestage']);
  assert.deepEqual([...m.keys()].sort(), ['ft', 'nyt']); // failed outlet stays failed for the run
});

test('review fix: browser items run grouped by adapter (one Chrome launch per outlet, not per switch)', () => {
  const PO = require('./gap-plan-order.js');
  const B = (id, o) => ({ id, strategy: 'BROWSER_SESSION', outletId: o });
  const work = [B(1, 'financialtimes'), B(2, 'telegraph'), { id: 3, strategy: 'PAID_FETCH', outletId: 'x' }, B(4, 'times-uk'), B(5, 'financialtimes'), B(6, 'sunday-times'), B(7, 'telegraph')];
  const name = (c) => { const a = A.adapterFor(c.outletId); return a && a.name; };
  const out = PO.groupBrowserSessions(work, name);
  assert.deepEqual(out.map((c) => c.id), [1, 5, 3, 2, 7, 4, 6]); // non-browser item keeps slot 2; times-uk + sunday-times share one adapter
  let switches = 0;
  out.filter((c) => c.strategy === 'BROWSER_SESSION').reduce((p, c) => { if (p && name(p) !== name(c)) switches++; return c; }, null);
  assert.equal(switches, 2); // ft -> telegraph -> thetimes
  assert.deepEqual(work.map((c) => c.id), [1, 2, 3, 4, 5, 6, 7]); // input untouched
});

test('review fix: adapter grouping never pulls a retry or a lower band ahead of a fresh higher-priority gap', () => {
  const PO = require('./gap-plan-order.js');
  const name = (c) => { const a = A.adapterFor(c.outletId); return a && a.name; };
  const B = (id, o, extra) => ({ id, strategy: 'BROWSER_SESSION', outletId: o, ...extra });
  // fresh FT, fresh Times, then an FT retry: the retry must not jump the fresh Times gap
  const work = [B(1, 'financialtimes'), B(2, 'times-uk'), B(3, 'financialtimes', { attempts: 2 })];
  assert.deepEqual(PO.groupBrowserSessions(work, name).map((c) => c.id), [1, 2, 3]);
  // recent band-2 ft after historic? partitions keep their order; grouping only inside each
  const mixed = [B(1, 'telegraph', { recency: 'recent' }), B(2, 'financialtimes', { recency: 'recent' }), B(3, 'telegraph', { recency: 'recent' }), B(4, 'financialtimes'), B(5, 'telegraph'), B(6, 'financialtimes')];
  assert.deepEqual(PO.groupBrowserSessions(mixed, name).map((c) => c.id), [1, 3, 2, 4, 6, 5]);
});
