// BRO-7382: v3 earlier-run blend shadow. Real lib, no copies of its logic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const V3 = require('../../scripts/lib/review-forecast-v3-blend.js');
const RF = require('../../scripts/lib/review-forecast.js');
const dayOf = (iso) => RF.toDay(iso);

const target = { id: 'tgt-2026', title: 'Target Show', openingDate: '2026-11-19', previewsStartDate: '2026-10-20' };
// cutoff = min(day before first preview = 2026-10-19, opening - 3 days = 2026-11-16) = 2026-10-19
const pool = [{ id: 'tgt-ob-2025', title: 'Target Show', category: 'off-broadway', openingDate: '2025-05-01' }, { id: 'tgt-we-2024', title: 'Target Show', category: 'west-end', openingDate: '2024-02-01' }];
const rv = (iso, score) => ({ day: dayOf(iso), score });
const v2fb = { forecast: 70, forecastRaw: 70.4, lo80: 58, hi80: 82, inputsPresent: ['v1'] };
const v2ss = { forecast: 72, forecastRaw: 72.2, lo80: 60, hi80: 84, inputsPresent: ['v1', 'showScore'] };

test('earlier score: own record first, dated by the cutoff, shrunk toward mu by count (k=5), origin from market', () => {
  const reviewsByShow = new Map([['tgt-ob-2025', [rv('2025-05-02', 90), rv('2025-05-03', 80), rv('2026-10-25', 10)]]]); // last one is after the cutoff
  const e = V3.earlierRunScore(target, { pool, reviewsByShow }, 70);
  assert.equal(e.n, 2); assert.equal(e.source, 'own-record'); assert.equal(e.origin, 'Off-Broadway');
  assert.equal(e.raw, 85); assert.ok(Math.abs(e.score - (2 * 85 + 5 * 70) / 7) < 1e-9);
  assert.doesNotThrow(() => V3.assertNoLeakageV3(target, e));
  assert.throws(() => V3.assertNoLeakageV3(target, { ...e, newest: '2026-10-25' }), /LEAKAGE/);
});

test('earlier score: falls back to the web-collected file; late and undated entries are dropped; origin from show-origins', () => {
  const ctx = { pool: [], reviewsByShow: new Map(), earlierRun: { 'tgt-2026': [[60, '2025-06-01', 0], [90, '2026-10-30', 0], [99, 'garbage', 0], [70, '2025', 0]] }, origins: { 'tgt-2026': { path: ['regional-us', 'london'] } } };
  const e = V3.earlierRunScore(target, ctx, 70);
  assert.equal(e.n, 2); assert.equal(e.source, 'web-compact'); assert.equal(e.origin, 'out-of-town'); assert.equal(e.raw, 65);
  assert.equal(V3.earlierRunScore(target, { pool: [], earlierRun: {} }, 70), null);
  assert.equal(V3.earlierRunScore(target, ctx, null), null);
});

test('origin labels', () => {
  assert.equal(V3.originLabel('west-end', null), 'London');
  assert.equal(V3.originLabel(null, { path: ['london'] }), 'London');
  assert.equal(V3.originLabel(null, { path: ['off-broadway'] }), 'Off-Broadway');
  assert.equal(V3.originLabel(null, { path: [] }), 'unknown');
  assert.equal(V3.originLabel(null, null), 'unknown');
});

test('weight: 0 under 10 rows or when only later seasons exist; uses only earlier seasons; picks the best grid weight', () => {
  const mk = (n, season) => Array.from({ length: n }, (_, i) => ({ season, y: 80, baseV1: 60, baseV2: 61, ec: 80, id: `r${season}-${i}` }));
  assert.equal(V3.chooseWeight(mk(9, 2020), 2021, 'v2').weight, 0);
  assert.equal(V3.chooseWeight(mk(20, 2022), 2021, 'v2').weight, 0); // later season is never used
  assert.equal(V3.chooseWeight(mk(20, 2020), 2021, 'v2').weight, 1); // ec is exact
  const noisy = mk(20, 2020).map((r, i) => ({ ...r, ec: 80 + (i % 2 ? 30 : -30), baseV1: 100 }));
  const w = V3.chooseWeight(noisy, 2021, 'v1').weight; assert.ok(w >= 0 && w <= 1);
});

test('weight (v2 base) ignores rows where the audience input did not change the base', () => {
  const same = Array.from({ length: 20 }, (_, i) => ({ season: 2020, y: 80, baseV1: 60, baseV2: 60, ec: 80, id: `s${i}` }));
  assert.equal(V3.chooseWeight(same, 2021, 'v2').weight, 0);
  assert.equal(V3.chooseWeight(same, 2021, 'v1').weight, 1);
});

test('buildV3Shadow: blends only with an earlier score and a record dated by opening minus 3 days; otherwise v3 = base', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ season: 2020, y: 80, baseV1: 60, baseV2: 61, ec: 80, id: `r${i}` }));
  const earlier = { n: 6, raw: 80, score: 80, source: 'web-compact', origin: 'out-of-town', ref: null, newest: '2025-01-01' };
  const a = V3.buildV3Shadow({ v2: v2ss, earlier, weightRows: rows, openingDate: '2026-11-19', recordedAt: '2026-11-10' });
  assert.equal(a.v3Applied, true); assert.equal(a.v3Weight, 1); assert.equal(a.v3Forecast, 80); assert.equal(a.v3Base, 'v2'); assert.equal(a.v3Origin, 'out-of-town');
  assert.equal(a.v3Hi80 - a.v3Lo80, v2ss.hi80 - v2ss.lo80 - (a.v3Hi80 === 100 ? v2ss.hi80 + (80 - 72.2) - 100 : 0));
  const fb = V3.buildV3Shadow({ v2: v2fb, earlier, weightRows: rows, openingDate: '2026-11-19', recordedAt: '2026-11-10' });
  assert.equal(fb.v3Base, 'v1'); // v2 fell back, so the base (and the weight set) is v1
  const none = V3.buildV3Shadow({ v2: v2ss, earlier: null, weightRows: rows, openingDate: '2026-11-19', recordedAt: '2026-11-10' });
  assert.equal(none.v3Applied, false); assert.equal(none.v3Forecast, v2ss.forecast); assert.match(none.v3FallbackReason, /no earlier-run/);
  const late = V3.buildV3Shadow({ v2: v2ss, earlier, weightRows: rows, openingDate: '2026-11-19', recordedAt: '2026-11-17' });
  assert.equal(late.v3Applied, false); assert.equal(late.v3Forecast, v2ss.forecast);
  const noRows = V3.buildV3Shadow({ v2: v2ss, earlier, weightRows: [], openingDate: '2026-11-19', recordedAt: '2026-11-10' });
  assert.equal(noRows.v3Applied, false); assert.match(noRows.v3FallbackReason, /no weight rows/); assert.equal(noRows.v3Forecast, v2ss.forecast);
});

test('frozen v3 row: latest applied row at or before opening minus 3 days', () => {
  const mk = (recordedAt, applied) => ({ showId: 's', recordedAt, v3: { v3Applied: applied } });
  const rows = [mk('2026-11-05', true), mk('2026-11-12', true), mk('2026-11-13', false), mk('2026-11-17', true)];
  assert.equal(V3.frozenV3Row(rows, 's', '2026-11-19').recordedAt, '2026-11-12');
  assert.equal(V3.frozenV3Row(rows, 'other', '2026-11-19'), null);
});

test('grade row + scoreboard: v3 compared with the base stored on the same frozen row', () => {
  const P = require('../../scripts/lib/review-forecast-pilot.js');
  const frozen = { showId: 's', recordedAt: '2026-11-18', forecast: 70, categoryMean: 68, lo80: 60, hi80: 80 };
  const f3 = { showId: 's', recordedAt: '2026-11-10', forecast: 71, v2: v2ss, v3: { v3Applied: true, v3Forecast: 78, v3Origin: 'out-of-town', v3EarlierSource: 'web-compact', v3EarlierN: 6, v3Weight: 0.3, v3Base: 'v2', v3ModelVersion: V3.MODEL_VERSION } };
  const g = P.buildGradeRow({ showId: 's', openingDate: '2026-11-19', today: '2026-12-10', frozen, criticScore: 80, frozenV3: f3 });
  assert.equal(g.forecastV3, 78); assert.equal(g.missForecastV3, 2); assert.equal(g.v3BaseSameRow, 72); assert.equal(g.missV3BaseSameRow, 8);
  const none = P.buildGradeRow({ showId: 's2', openingDate: '2026-11-19', today: '2026-12-10', frozen, criticScore: 80 });
  assert.equal(none.v3Applied, false); assert.equal(none.forecastV3, null);
  const sb = P.scoreboard([g, none]).v3EarlierBlend;
  assert.equal(sb.all.shows, 1); assert.equal(sb.all.v3.mae, 2); assert.equal(sb.all.base.mae, 8); assert.equal(sb.outOfTown.shows, 1); assert.equal(sb.bySource['own-record'].shows, 0);
});
