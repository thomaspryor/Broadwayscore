/** BRO-7347: leakage guard for the extra pre-opening inputs (awards, panel, calendar, house). Run: node --test tests/unit/review-forecast-v2-extra-leakage.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const RF = require('../../scripts/lib/review-forecast.js');
const EX = require('../../scripts/lib/review-forecast-v2-extra.js');

const day = (iso, d) => new Date(RF.toDay(iso) * 86400000 + d * 86400000).toISOString().slice(0, 10);
const T_DATE = '2020-03-20';
const target = { id: 'T', title: 'Same Title', openingDate: T_DATE, type: 'play', venue: 'Vivian Beaumont Theater', category: 'broadway' };
const mk = (id, open, extra = {}) => ({ id, title: 'Same Title', openingDate: open, type: 'play', category: 'broadway', score: 70, rc: 20, ...extra });
const critics = (n, at, score) => { const m = new Map(); for (let i = 0; i < n; i++) m.set(`o${i}|c`, Array.from({ length: 4 }, (_, j) => ({ day: RF.toDay(at) - j * 10, score, type: 'play', weight: 1, showId: 'x' }))); return m; };

test('awards: honours dated before opening minus lag count; later seasons never do', () => {
  const early = mk('e', '2018-01-01'); const later = mk('l', day(T_DATE, 40));
  const awards = { e: { olivier: { season: '2018-19', wins: ['A'], nominatedFor: ['A'] }, lortel: { season: '2019-20', wins: ['B'] } }, l: { obie: { season: '2019-20', wins: ['Z', 'Y'] } } };
  const f = EX.buildExtraFeatures(target, { pool: [early, later], awards, panel: null }, 70);
  assert.equal(f.x.awardWins, Math.log1p(1), 'olivier 2018-19 (public 2019-06-30) counts; lortel 2019-20 (public 2020-06-30, after opening) and the later show do not');
  EX.assertNoLeakageExtra(target, f.provenance);
});

test('panel: reviews after the cutoff change nothing', () => {
  const base = EX.buildExtraFeatures(target, { pool: [], awards: null, panel: { byCritic: critics(6, '2020-01-01', 60) } }, 70);
  const m = critics(6, '2020-01-01', 60);
  for (const l of m.values()) l.push({ day: RF.toDay(T_DATE) - 1, score: 5, type: 'play', weight: 1, showId: 'y' }, { day: RF.toDay(T_DATE) + 30, score: 5, type: 'play', weight: 1, showId: 'z' });
  const withLate = EX.buildExtraFeatures(target, { pool: [], awards: null, panel: { byCritic: m } }, 70);
  assert.deepEqual(withLate.x, base.x);
  assert.ok(base.has.panel && base.x.panelAll < 0);
});

test('calendar and house flag read only the opening date and venue', () => {
  assert.equal(EX.buildExtraFeatures(target, { pool: [], awards: null, panel: null }, 70).x.springCrush, 1);
  assert.equal(EX.buildExtraFeatures({ ...target, openingDate: '2020-10-01' }, { pool: [], awards: null, panel: null }, 70).x.springCrush, 0);
  assert.equal(EX.buildExtraFeatures(target, { pool: [], awards: null, panel: null }, 70).x.nonprofitHouse, 1);
  assert.equal(EX.buildExtraFeatures({ ...target, venue: 'Lyceum Theatre' }, { pool: [], awards: null, panel: null }, 70).x.nonprofitHouse, 0);
});

test('assertNoLeakageExtra refuses undated, in-lag, and post-opening inputs', () => {
  const bad = (p) => assert.throws(() => EX.assertNoLeakageExtra(target, [p]), /LEAKAGE/);
  bad({ kind: 'award', ref: 'e:olivier', date: null });
  bad({ kind: 'award', ref: 'e:olivier', date: T_DATE });
  bad({ kind: 'panel', ref: 'x', date: day(T_DATE, -(RF.LAG_DAYS - 1)) });
  assert.equal(EX.assertNoLeakageExtra(target, [{ kind: 'award', ref: 'e', date: day(T_DATE, -RF.LAG_DAYS) }]), true);
});
