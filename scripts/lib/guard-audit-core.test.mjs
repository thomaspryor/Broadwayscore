// BRO-3011: requires the real guard-audit-core.js and breaker-transitions.js (rule 15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const core = require('./guard-audit-core.js');

const NOW = '2026-10-13T08:00:00.000Z';
const day = (n) => new Date(Date.parse('2026-10-13T00:00:00Z') - n * 86400000).toISOString().slice(0, 10);
const trip = (key, d, ceiling = 250, prevTs = null) => ({ ts: `${d}T03:00:00.000Z`, conditionKey: key, from: 'ok', to: 'tripped', day: d, ceiling, ceilingSource: 'plan', prevTs });
const ok = (key, d, prevTs) => ({ ts: `${d}T20:00:00.000Z`, conditionKey: key, from: 'tripped', to: 'ok', day: d, ceiling: 0, ceilingSource: 'opening-window-reserve', prevTs });
const ledger = (rows) => ({ rows, corruptLines: 0, missing: false, unreadable: false });

function chain(key, days) {
  const rows = []; let prev = null;
  for (const d of days) { const t = trip(key, d, 250, prev); rows.push(t); prev = t.ts; const o = ok(key, d, prev); rows.push(o); prev = o.ts; }
  return rows;
}
const guard = (snap, key) => snap.guards.find((g) => g.key === key);

test('> 2 trip days in 7 → DEFECT; Bright Data with acceptedDailyTrip → ACCEPTED', () => {
  const rows = [...chain('sd-circuit-breaker', [day(1), day(2), day(3)]), ...chain('bd-circuit-breaker-web_unlocker2', [day(1), day(2), day(3)])];
  const snap = core.runGuardAudit({ ledger: ledger(rows), spendRows: [], dailyRows: [], thresholds: { acceptedDailyTrip: { brightdata: true } }, nowIso: NOW });
  assert.equal(guard(snap, 'sd-circuit-breaker').verdict, 'DEFECT');
  assert.equal(guard(snap, 'sd-circuit-breaker').days, 3);
  assert.equal(guard(snap, 'bd-circuit-breaker-web_unlocker2').verdict, 'ACCEPTED');
  assert.deepEqual(snap.defects, ['sd-circuit-breaker']);
});

test('trips older than 7 days do not count; 2 days is OK', () => {
  const rows = chain('sd-circuit-breaker', [day(1), day(2), day(9), day(10)]);
  const snap = core.runGuardAudit({ ledger: ledger(rows), spendRows: [], dailyRows: [], nowIso: NOW });
  assert.equal(guard(snap, 'sd-circuit-breaker').verdict, 'OK');
  assert.equal(guard(snap, 'sd-circuit-breaker').days, 2);
});

test('union-duplicated rows do not double count', () => {
  const rows = chain('sd-circuit-breaker', [day(1), day(2)]);
  const snap = core.runGuardAudit({ ledger: ledger([...rows, ...rows]), spendRows: [], dailyRows: [], nowIso: NOW });
  assert.equal(guard(snap, 'sd-circuit-breaker').days, 2);
});

test('<= 2 days on a lower-bound count (chain gap or corrupt lines) → UNCERTAIN, never OK', () => {
  const rows = chain('sd-circuit-breaker', [day(1)]);
  rows.push(trip('sd-circuit-breaker', day(2), 250, '2026-10-01T00:00:00.000Z')); // dangling prevTs = lost rows
  const snap = core.runGuardAudit({ ledger: ledger(rows), spendRows: [], dailyRows: [], nowIso: NOW });
  assert.equal(guard(snap, 'sd-circuit-breaker').verdict, 'UNCERTAIN');
  const snap2 = core.runGuardAudit({ ledger: { ...ledger(chain('sd-circuit-breaker', [day(1)])), corruptLines: 1 }, spendRows: [], dailyRows: [], nowIso: NOW });
  assert.equal(guard(snap2, 'sd-circuit-breaker').verdict, 'UNCERTAIN');
});

test('a guard with no rows ever is NO DATA (never "0 trips"); a missing ledger makes every guard NO DATA', () => {
  const snap = core.runGuardAudit({ ledger: ledger(chain('sd-circuit-breaker', [day(1)])), spendRows: [], dailyRows: [], nowIso: NOW });
  const sb = guard(snap, 'sb-circuit-breaker');
  assert.equal(sb.verdict, 'NO DATA');
  assert.match(snap.items.find((i) => i.title === 'sb-circuit-breaker').detail, /no data/);
  assert.doesNotMatch(snap.items.find((i) => i.title === 'sb-circuit-breaker').detail, /0 trip/);
  const missing = core.runGuardAudit({ ledger: { rows: [], corruptLines: 0, missing: true, unreadable: false }, spendRows: [], dailyRows: [], nowIso: NOW });
  assert.ok(missing.guards.every((g) => g.verdict === 'NO DATA'));
  assert.match(missing.bannerText, /missing or unreadable/);
});

test('a -shadow key is SHADOW, never DEFECT, and gets its own alert key', () => {
  const snap = core.runGuardAudit({ ledger: ledger(chain('sb-circuit-breaker-shadow', [day(1), day(2), day(3), day(4)])), spendRows: [], dailyRows: [], nowIso: NOW });
  const g = guard(snap, 'sb-circuit-breaker-shadow');
  assert.equal(g.verdict, 'SHADOW');
  assert.equal(g.alertKey, 'guard-audit:sb-shadow');
  assert.ok(!snap.defects.includes('sb-circuit-breaker-shadow'));
});

test('alert keys never contain "circuit-breaker" (owner-alert-router NEVER_QUIET_CONDITION_RE)', () => {
  for (const k of core.expectedGuards()) assert.doesNotMatch(core.describeGuard(k).alertKey, /circuit-breaker/);
});

test('spend: only billed rows on trip days whose fallback_from is THIS guard\'s label; BD priced per request; serp_api1 has no label', () => {
  const rows = [...chain('sd-circuit-breaker', [day(1)]), ...chain('bd-circuit-breaker-web_unlocker2', [day(1)]), ...chain('bd-circuit-breaker-serp_api1', [day(1)])];
  const spendRows = [
    { ts: `${day(1)}T05:00:00Z`, provider: 'brightdata', success: true, credits: null, fallback_from: 'sd-breaker' },
    { ts: `${day(1)}T05:01:00Z`, provider: 'scrapingbee', success: true, credits: 5, fallback_from: 'bd-budget' },
    { ts: `${day(1)}T05:02:00Z`, provider: 'scrapingbee', success: false, credits: 5, fallback_from: 'bd-budget' }, // not billed
    { ts: `${day(1)}T05:03:00Z`, provider: 'scrapingbee', success: true, credits: 5, fallback_from: 'scrapingdog' }, // plain miss, not a trip
    { ts: `${day(4)}T05:00:00Z`, provider: 'brightdata', success: true, credits: null, fallback_from: 'sd-breaker' }, // not a trip day
  ];
  const snap = core.runGuardAudit({ ledger: ledger(rows), spendRows, dailyRows: [], nowIso: NOW });
  const sd = guard(snap, 'sd-circuit-breaker');
  assert.equal(sd.spend.rows, 1);
  assert.equal(sd.spend.usd, 0); // $0.0015 rounds to $0.00 at cents
  const bd = guard(snap, 'bd-circuit-breaker-web_unlocker2');
  assert.equal(bd.spend.rows, 1);
  assert.match(bd.spend.caveat, /per-run budget/);
  assert.equal(guard(snap, 'bd-circuit-breaker-serp_api1').spend.note, 'n/a (no skip label)');
});

test('spendByDayFromLedger prices SD/SB per credit and BD per request; unpriced surfaced, not dropped', () => {
  const out = core.spendByDayFromLedger([
    { ts: '2026-10-12T01:00:00Z', provider: 'brightdata', success: true, credits: null, fallback_from: 'sd-breaker' },
    { ts: '2026-10-12T01:00:00Z', provider: 'brightdata', success: true, credits: null, fallback_from: 'sd-breaker' },
    { ts: '2026-10-12T01:00:00Z', provider: 'mystery', success: true, credits: 3, fallback_from: 'sd-breaker' },
  ], ['sd-circuit-breaker'], ['2026-10-12']);
  assert.equal(out['2026-10-12']['sd-circuit-breaker'].usd, 0.003);
  assert.equal(out['2026-10-12']['sd-circuit-breaker'].rows, 3);
  assert.equal(out['2026-10-12']['sd-circuit-breaker'].unpriced, 1);
});

test('spend history: complete stored days win; partial (today) days are recomputed; coverage start reported', () => {
  const guards = ['sd-circuit-breaker'];
  const prev = {
    [day(5)]: { partial: false, guards: { 'sd-circuit-breaker': { usd: 1.5, rows: 10, unpriced: 0 } } },
    [day(0)]: { partial: true, guards: { 'sd-circuit-breaker': { usd: 0.1, rows: 1, unpriced: 0 } } },
  };
  const fresh = { [day(0)]: { 'sd-circuit-breaker': { usd: 0.4, rows: 4, unpriced: 0 } } };
  const merged = core.mergeSpendHistory(prev, fresh, { ledgerStartTs: `${day(2)}T06:44:00Z`, nowIso: NOW, untilDay: day(0), guards });
  assert.equal(merged[day(5)].guards['sd-circuit-breaker'].usd, 1.5, 'complete stored day survives the ledger rotating it away');
  assert.equal(merged[day(0)].guards['sd-circuit-breaker'].usd, 0.4, 'partial day recomputed');
  assert.equal(merged[day(0)].partial, true);
  assert.equal(merged[day(2)].partial, true, 'ledger starts mid-day → partial');
  assert.equal(merged[day(1)].partial, false, 'whole day covered and over → complete');
});

test('cap drift: ceiling that bit (latest trip row) < 1.5x 14d median → drift; env pin never flagged; a recovery-row 0 alone is not drift', () => {
  const daily = Array.from({ length: 10 }, (_, k) => ({ day: day(k + 1), capturedAt: `${day(k + 1)}T23:00Z`, providers: { brightdata: { status: 'ok', unlockerReqs: 2800, serpReqs: 200 }, scrapingdog: { status: 'ok', dayCredits: 44000, cycleUsed: 1, cap: 9 } } }));
  const rows = chain('bd-circuit-breaker-web_unlocker2', [day(1)]);
  const d = core.capDrift('bd-circuit-breaker-web_unlocker2', { transitionRows: rows, state: { ceiling: 0 }, dailyRows: daily, untilDay: day(0) });
  assert.equal(d.ceiling, 250);
  assert.equal(d.drift, true);
  assert.equal(d.currentZero, true);
  const sdPin = core.capDrift('sd-circuit-breaker', { transitionRows: [], state: { ceiling: 1000, ceilingSource: 'env' }, dailyRows: daily, untilDay: day(0) });
  assert.equal(sdPin.drift, false);
  const zeroOnly = core.capDrift('bd-circuit-breaker-serp_api1', { transitionRows: [ok('bd-circuit-breaker-serp_api1', day(1), null)], state: { ceiling: 0 }, dailyRows: daily, untilDay: day(0) });
  assert.equal(zeroOnly.drift, false);
  assert.equal(zeroOnly.ceiling, null);
});

test('snapshot has the renderNamedDigestBlock shape and HTML escapes', () => {
  const snap = core.runGuardAudit({ ledger: ledger(chain('sd-circuit-breaker', [day(1)])), spendRows: [], dailyRows: [], nowIso: NOW });
  assert.equal(typeof snap.bannerText, 'string');
  assert.ok(Array.isArray(snap.items) && snap.items.every((i) => typeof i.title === 'string' && typeof i.detail === 'string'));
  assert.doesNotMatch(core.renderGuardAuditHtml({ bannerText: '<x>', items: [{ title: 'a&b', detail: '"q"' }] }), /<x>|a&b|"q"/);
});

// ── post-land review fixes ──────────────────────────────────────────────────
test('review: a partial day recounted after the ledger start moved later keeps the larger stored count', () => {
  const guards = ['sd-circuit-breaker'];
  const prev = { [day(1)]: { partial: true, guards: { 'sd-circuit-breaker': { usd: 2, rows: 40, unpriced: 0 } } } };
  const fresh = { [day(1)]: { 'sd-circuit-breaker': { usd: 0.5, rows: 10, unpriced: 0 } } };
  const merged = core.mergeSpendHistory(prev, fresh, { ledgerStartTs: `${day(1)}T20:00:00Z`, nowIso: NOW, untilDay: day(0), guards });
  assert.equal(merged[day(1)].guards['sd-circuit-breaker'].rows, 40);
  const bigger = core.mergeSpendHistory(prev, { [day(1)]: { 'sd-circuit-breaker': { usd: 3, rows: 60, unpriced: 0 } } }, { ledgerStartTs: `${day(1)}T01:00:00Z`, nowIso: NOW, untilDay: day(0), guards });
  assert.equal(bigger[day(1)].guards['sd-circuit-breaker'].rows, 60);
});

test('review: a breaker in shadow mode (state.shadow / enforce:false) is never cap drift', () => {
  const daily = Array.from({ length: 10 }, (_, k) => ({ day: day(k + 1), capturedAt: `${day(k + 1)}T23:00Z`, providers: { scrapingbee: { status: 'ok', dayCredits: 30000, cycleUsed: 1, cap: 9 } } }));
  const d = core.capDrift('sb-circuit-breaker', { transitionRows: [], state: { ceiling: 31000, ceilingSource: 'plan', shadow: true, enforce: false }, dailyRows: daily, untilDay: day(0) });
  assert.equal(d.drift, false);
  assert.match(d.note, /shadow/);
});

test('review: the drift median excludes today (a partial day)', () => {
  const daily = [
    ...Array.from({ length: 7 }, (_, k) => ({ day: day(k + 1), capturedAt: 'x', providers: { scrapingdog: { status: 'ok', dayCredits: 10000, cycleUsed: 1, cap: 9 } } })),
    { day: day(0), capturedAt: 'x', providers: { scrapingdog: { status: 'ok', dayCredits: 1, cycleUsed: 1, cap: 9 } } },
  ];
  const d = core.capDrift('sd-circuit-breaker', { transitionRows: [], state: { ceiling: 14000, ceilingSource: 'plan' }, dailyRows: daily, untilDay: day(0) });
  assert.equal(d.median14d, 10000);
  assert.equal(d.drift, true);
});
