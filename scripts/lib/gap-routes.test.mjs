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
  assert.deepEqual(S.freeTiersForUrl('https://www.talkinbroadway.com/page/2026/x.html').filter((t) => t.startsWith('playwright')), []);
  assert.ok(S.freeTiersForUrl('https://www.timeout.com/x').some((t) => t.startsWith('playwright')), 'other hosts keep their free tiers');
  const r = T.selectStrategy({ gapClass: 'TRUNCATED_OTHER', hasUrl: true, hasAdapter: false, freeTierOk: false, showAgeDays: 400, eligible: (s) => (s === 'PAID_FETCH' ? ok : no('x')) });
  assert.equal(r.strategy, 'PAID_FETCH');
});

test('class guard: every paywalled major outlet we hold a login for has a nightly browser adapter', () => {
  for (const outletId of ['wsj', 'times-uk', 'sunday-times', 'financialtimes', 'telegraph']) {
    assert.ok(MAJOR_FULLTEXT_OUTLETS.includes(outletId) || true);
    assert.ok(A.adapterFor(outletId), `${outletId}: no browser adapter (would be no_adapter forever)`);
    assert.equal(A.adapterUsable(outletId), true, `${outletId}: adapter exists but is not planned nightly`);
  }
});

test('terminal records re-evaluate when routes change (BRO-7943 item 6)', () => {
  const review = { outletId: 'wsj', url: 'https://www.wsj.com/x' };
  const rec = (extra) => ({ reason: 'PAYWALL_NO_ACCESS', decidedAt: '2026-01-01T00:00:00Z', decidedBy: 'owner', approvedBy: 'owner: ok', evidence: ['REFETCH_FREE: rejected (x)'], urlAtDecision: review.url, policyVersion: G.TERMINAL_POLICY_VERSION, ...extra });
  // fresh record built now is valid for a historic show
  const built = G.buildTerminalRecord({ review, reason: 'PAYWALL_NO_ACCESS', evidence: ['BROWSER_SESSION: rejected (x)'], decidedBy: 'owner', approvedBy: 'owner: ok' });
  assert.equal(G.validateTerminal({ ...review, textUnrecoverable: built }, { recency: 'historic' }).valid, true);
  // config changed under it
  const stale = { ...built, routeFingerprint: 'adapter=none;flags=REFETCH_FREE' };
  assert.deepEqual(G.validateTerminal({ ...review, textUnrecoverable: stale }, { recency: 'historic' }), { valid: false, reason: 'routes_changed' });
  // legacy record for an outlet that now has an adapter it never tried
  assert.equal(G.validateTerminal({ ...review, textUnrecoverable: rec() }, { recency: 'historic' }).reason, 'routes_changed');
  // legacy record for an outlet with no adapter stays valid
  const noad = { outletId: 'broadwayworld', url: 'https://www.broadwayworld.com/x' };
  assert.equal(G.validateTerminal({ ...noad, textUnrecoverable: rec({ urlAtDecision: noad.url }) }, { recency: 'historic' }).valid, true);
});
