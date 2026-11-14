/**
 * BRO-7314: leakage guard for the pre-opening review forecast.
 *
 * The forecast may only use inputs dated before a show's opening night. These
 * tests build a small synthetic world and require() the real module (never a
 * copy of its logic). If any input postdates the opening, they fail.
 *
 * Run: node --test tests/unit/review-forecast-leakage.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const RF = require('../../scripts/lib/review-forecast.js');

const team = (dir, writer) => RF.peopleOf([
  { name: dir, role: 'Director' }, { name: writer, role: 'Playwright' },
  { name: 'Some Designer', role: 'Scenic Design' }, { name: 'Mus Director', role: 'Music Direction' },
]);

let seq = 0;
function show(over) {
  seq += 1;
  return { id: `s${seq}`, title: `Title ${seq}`, openingDate: '2015-01-01', score: 70, rc: 20, category: 'broadway',
    type: 'play', isRevival: false, venue: 'Venue A', people: team('Dana Dir', 'Wes Writer'), ...over };
}
const day = (iso, delta) => new Date(RF.toDay(iso) * 86400000 + delta * 86400000).toISOString().slice(0, 10);

// 12 earlier-season plays give a baseline; Dana directed some of them.
function world() {
  const pool = [];
  for (let i = 0; i < 12; i++) pool.push(show({ id: `base${i}`, title: `Base ${i}`, openingDate: day('2012-10-01', i * 20), score: 60 + (i % 4) * 5, people: team(i < 4 ? 'Dana Dir' : `Other ${i}`, `Writer ${i}`) }));
  return pool;
}
const TARGET_DATE = '2015-03-12'; // season starts 2014-06
const target = show({ id: 'TARGET', title: 'Target Play', openingDate: TARGET_DATE, score: 90 });

test('season boundary: June starts a new season', () => {
  assert.equal(RF.seasonStartYear('2015-05-31'), 2014);
  assert.equal(RF.seasonStartYear('2015-06-01'), 2015);
});

test('roles: directors and writers count, music direction and designers do not', () => {
  assert.equal(RF.roleGroup('Director'), 'dir');
  assert.equal(RF.roleGroup('Choreographer'), 'chor');
  assert.equal(RF.roleGroup('Book'), 'writer');
  assert.equal(RF.roleGroup('Music & Lyrics'), 'writer');
  assert.equal(RF.roleGroup('Music Direction'), null);
  assert.equal(RF.roleGroup('Music Supervision'), null);
  assert.equal(RF.roleGroup('Scenic Design'), null);
});

test('clean features pass the leakage guard', () => {
  const pool = world();
  const f = RF.buildFeatures(target, { pool, weeks: {}, origins: {} });
  assert.ok(f.provenance.length > 0);
  assert.equal(RF.assertNoLeakage(target, f.provenance), true);
});

test('a later show by the same director never feeds the forecast', () => {
  const pool = world();
  const before = RF.buildFeatures(target, { pool, weeks: {}, origins: {} });
  const later = show({ id: 'later', openingDate: day(TARGET_DATE, 30), score: 5, people: team('Dana Dir', 'Wes Writer') });
  const sameDay = show({ id: 'sameday', openingDate: TARGET_DATE, score: 5, people: team('Dana Dir', 'Wes Writer'), title: 'Target Play' });
  const after = RF.buildFeatures(target, { pool: [...pool, later, sameDay], weeks: {}, origins: {} });
  assert.deepEqual(after.x, before.x);
  assert.equal(after.mu, before.mu);
  assert.ok(!after.provenance.some((p) => p.ref === 'later' || p.ref === 'sameday'));
});

test('lag: a show that opened LAG_DAYS before counts, one day closer does not', () => {
  const pool = world();
  const ok = show({ id: 'okLag', openingDate: day(TARGET_DATE, -RF.LAG_DAYS), score: 95, people: team('Dana Dir', 'Nobody') });
  const tooNew = show({ id: 'tooNew', openingDate: day(TARGET_DATE, -(RF.LAG_DAYS - 1)), score: 20, people: team('Dana Dir', 'Nobody') });
  const f = RF.buildFeatures(target, { pool: [...pool, ok, tooNew], weeks: {}, origins: {} });
  assert.ok(f.provenance.some((p) => p.ref === 'okLag'));
  assert.ok(!f.provenance.some((p) => p.ref === 'tooNew'));
  RF.assertNoLeakage(target, f.provenance);
});

test('invariance: corrupting every input dated on or after opening changes nothing', () => {
  const pool = world();
  const extra = [show({ id: 'p1', openingDate: day(TARGET_DATE, 10), score: 10 }), show({ id: 'p2', openingDate: '2016-05-01', score: 99, title: 'Target Play' })];
  const weeks = {
    '2015-03-01': { TARGET: { capacity: 80, atp: 100 }, a: { capacity: 90, atp: 90 }, b: { capacity: 85, atp: 80 }, c: { capacity: 70, atp: 70 }, d: { capacity: 95, atp: 120 }, e: { capacity: 60, atp: 60 } },
    '2015-03-15': { TARGET: { capacity: 99, atp: 300 }, a: { capacity: 90, atp: 90 }, b: { capacity: 85, atp: 80 }, c: { capacity: 70, atp: 70 }, d: { capacity: 95, atp: 120 }, e: { capacity: 60, atp: 60 } },
  };
  const base = RF.buildFeatures(target, { pool: [...pool, ...extra], weeks, origins: {} });
  const D = RF.toDay(TARGET_DATE);
  const corruptPool = [...pool, ...extra].map((s) => (RF.toDay(s.openingDate) > D - RF.LAG_DAYS ? { ...s, score: 100 - s.score } : s));
  const corruptWeeks = { ...weeks, '2015-03-15': { ...weeks['2015-03-15'], TARGET: { capacity: 1, atp: 1 } } };
  const again = RF.buildFeatures(target, { pool: corruptPool, weeks: corruptWeeks, origins: {} });
  assert.deepEqual(again.x, base.x);
  assert.equal(again.mu, base.mu);
  assert.equal(base.hasGross, true);
  assert.ok(base.provenance.filter((p) => p.kind === 'gross-week').every((p) => p.date < TARGET_DATE));
});

test('grosses: the week ending the day before opening counts, the week containing opening does not', () => {
  const mk = (cap) => ({ TARGET: { capacity: cap, atp: 100 }, a: { capacity: 90, atp: 90 }, b: { capacity: 90, atp: 90 }, c: { capacity: 90, atp: 90 }, d: { capacity: 90, atp: 90 }, e: { capacity: 90, atp: 90 } });
  const weeks = { [day(TARGET_DATE, -1)]: mk(50), [TARGET_DATE]: mk(99), [day(TARGET_DATE, 7)]: mk(99) };
  const f = RF.buildFeatures(target, { pool: world(), weeks, origins: {} });
  assert.deepEqual(f.provenance.filter((p) => p.kind === 'gross-week').map((p) => p.date), [day(TARGET_DATE, -1)]);
  assert.ok(f.x.grossCap < 0, 'only the 50% week was used');
});

test('baseline uses earlier seasons only, never the target season', () => {
  const pool = world();
  const sameSeason = show({ id: 'sameSeason', openingDate: '2014-09-01', score: 5 });
  const f = RF.buildFeatures(target, { pool: [...pool, sameSeason], weeks: {}, origins: {} });
  assert.ok(!f.provenance.some((p) => p.ref === 'sameSeason' && p.kind === 'baseline'));
  const clean = RF.buildFeatures(target, { pool, weeks: {}, origins: {} });
  assert.equal(f.mu, clean.mu, 'a same-season show must not move the baseline mean');
  assert.ok(clean.provenance.some((p) => p.kind === 'baseline'), 'baseline use is recorded in provenance');
});

test('prior run: latest earlier production of the same title; never itself or later runs', () => {
  const pool = world();
  const old = show({ id: 'old', title: 'The Target Play', openingDate: '2010-01-01', score: 90, category: 'west-end' });
  const newer = show({ id: 'newer', title: 'Target Play', openingDate: '2014-01-01', score: 80, category: 'off-broadway' });
  const later = show({ id: 'laterRun', title: 'Target Play', openingDate: '2016-01-01', score: 10 });
  const f = RF.buildFeatures(target, { pool: [...pool, old, newer, later, { ...target }], weeks: {}, origins: {} });
  assert.equal(f.priorScore, 80);
  RF.assertNoLeakage(target, f.provenance);
});

test('assertNoLeakage rejects later, undated, and self-referencing inputs', () => {
  const f = RF.buildFeatures(target, { pool: world(), weeks: {}, origins: {} });
  const bad = (p) => assert.throws(() => RF.assertNoLeakage(target, [...f.provenance, p]), /LEAKAGE/);
  bad({ kind: 'person', ref: 'x', date: day(TARGET_DATE, 1) });
  bad({ kind: 'person', ref: 'x', date: TARGET_DATE });
  bad({ kind: 'person', ref: 'x', date: day(TARGET_DATE, -(RF.LAG_DAYS - 1)) });
  bad({ kind: 'person', ref: 'x', date: null });
  bad({ kind: 'prior-run', ref: 'TARGET', date: '2000-01-01' });
  bad({ kind: 'gross-week', ref: 'TARGET@w', date: TARGET_DATE });
});

test('ridge recovers a known linear relationship and shrinks with lambda', () => {
  const rows = [];
  for (let i = 0; i < 200; i++) { const a = Math.sin(i) * 5; rows.push({ x: { dir: a }, y: 2 * a }); }
  const m = RF.fitRidge(rows, ['dir'], 0.0001);
  assert.ok(Math.abs(RF.predictRidge(m, { dir: 3 }) - 6) < 0.05);
  const shrunk = RF.fitRidge(rows, ['dir'], 1e6);
  assert.ok(Math.abs(RF.predictRidge(shrunk, { dir: 3 })) < 1);
});

test('prior run: a same-title show inside the lag window is not used', () => {
  const inLag = show({ id: 'inLag', title: 'Target Play', openingDate: day(TARGET_DATE, -(RF.LAG_DAYS - 1)), score: 5 });
  const f = RF.buildFeatures(target, { pool: [...world(), inLag], weeks: {}, origins: {} });
  assert.equal(f.priorScore, null);
  assert.ok(!f.provenance.some((p) => p.ref === 'inLag'));
});
