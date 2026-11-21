import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { forecast, band, peopleOf } = require('./lib/critic-score-forecast.js');
const { backtest, metrics } = require('./predict-critic-score.js');

const mk = (i, score, extra = {}) => ({
  id: 's' + i, title: 'T' + i, openingDate: `2020-01-${String(i % 28 + 1).padStart(2, '0')}`.replace('2020', String(2000 + Math.floor(i / 28))),
  category: 'broadway', type: 'play', isRevival: false, score, people: { creative: [], cast: [] }, ...extra,
});
const hist = Array.from({ length: 40 }, (_, i) => mk(i, 70));

test('band edges', () => {
  assert.equal(band(85), 'Rave'); assert.equal(band(84.9), 'Positive');
  assert.equal(band(55), 'Mixed'); assert.equal(band(54), 'Negative');
});

test('no leakage: shows opening on/after the target are ignored', () => {
  const target = mk(20, null, { id: 'target' });
  const future = Array.from({ length: 10 }, (_, i) => mk(60 + i, 10, { id: 'f' + i }));
  const a = forecast(target, hist);
  const b = forecast(target, [...hist, ...future]);
  assert.equal(a.pred, b.pred);
});

test('returns null with too little history', () => {
  assert.equal(forecast(mk(5, null), hist.slice(0, 3)), null);
});

test('people with strong track records move the forecast up, shrunk', () => {
  const stars = hist.map((h, i) => (i < 4 ? { ...h, score: 90, people: { creative: ['jane doe'], cast: [] } } : h));
  const plain = forecast(mk(39, null, { id: 'x' }), stars);
  const withJane = forecast(mk(39, null, { id: 'x', people: { creative: ['jane doe'], cast: [] } }), stars);
  assert.ok(withJane.pred > plain.pred);
  assert.ok(withJane.pred < 90);
});

test('prior run of the same production is blended in', () => {
  const rows = hist.map((h, i) => (i === 0 ? { ...h, score: 95, originalProductionId: 'p1' } : h));
  const f = forecast(mk(39, null, { id: 'x', originalProductionId: 'p1' }), rows);
  assert.equal(f.priorScore, 95);
  assert.ok(f.pred > 75);
});

test('peopleOf keeps creative roles and top-3 billed cast only', () => {
  const p = peopleOf({ creativeTeam: [{ name: 'A B', role: 'Director' }, { name: 'C D', role: 'Set Designer' }],
    cast: [1, 2, 3, 4].map((n) => ({ name: 'Star ' + String.fromCharCode(96 + n) })) });
  assert.deepEqual(p.creative, ['a b']);
  assert.equal(p.cast.length, 3);
});

test('backtest + metrics run and report both baselines', () => {
  const rows = hist.map((h, i) => ({ ...h, score: 60 + (i % 20) }));
  const res = backtest(rows, '2001-01-01');
  assert.ok(res.length > 0);
  const m = metrics(res);
  for (const k of ['n', 'maeModel', 'maeCategoryMean', 'bandHitModel', 'calibration']) assert.ok(k in m);
});

test('same-day opening and later siblings never supply history', () => {
  const target = mk(20, null, { id: 'target', originalProductionId: 'p9' });
  const sameDay = { ...mk(20, 99, { id: 'sd', originalProductionId: 'p9' }) };
  const later = { ...mk(60, 99, { id: 'later', originalProductionId: 'p9' }) };
  const f = forecast(target, [...hist, sameDay, later]);
  assert.equal(f.priorScore, null);
});

test('title-only match across different category is rejected', () => {
  const other = { ...mk(1, 95, { id: 'o', title: 'Giant', category: 'off-broadway' }) };
  const f = forecast(mk(39, null, { id: 'x', title: 'Giant' }), [...hist, other]);
  assert.equal(f.priorScore, null);
});

test('backtest skips targets with no baseline instead of scoring baseline as 0', () => {
  const rows = [...hist.slice(0, 12), mk(50, 80, { id: 'solo', category: 'west-end' })];
  const res = backtest(rows, '2001-01-01');
  assert.ok(res.every((r) => r.catMean != null));
});

test('a person credited in two roles counts once', () => {
  const dual = hist.map((h, i) => (i < 4 ? { ...h, score: 95, people: { creative: ['jo'], cast: ['jo'] } } : h));
  const one = hist.map((h, i) => (i < 4 ? { ...h, score: 95, people: { creative: ['jo'], cast: [] } } : h));
  const t = mk(39, null, { id: 'x', people: { creative: ['jo'], cast: [] } });
  assert.equal(forecast(t, dual).pred, forecast(t, one).pred);
});

test('conflicting production ids block a same-title prior match', () => {
  const other = { ...mk(1, 95, { id: 'o', title: 'T39', originalProductionId: 'A' }) };
  const f = forecast(mk(39, null, { id: 'x', title: 'T39', originalProductionId: 'B' }), [...hist, other]);
  assert.equal(f.priorScore, null);
});
