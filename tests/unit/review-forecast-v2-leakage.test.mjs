/**
 * BRO-7347: leakage guard for the v2 research inputs (opening-night cast, preview signals,
 * pre-opening audience capture). require()s the real modules; builds a synthetic world.
 * Run: node --test tests/unit/review-forecast-v2-leakage.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const RF = require('../../scripts/lib/review-forecast.js');
const V2 = require('../../scripts/lib/review-forecast-v2-inputs.js');

const TARGET_DATE = '2015-03-12';
const day = (iso, d) => new Date(RF.toDay(iso) * 86400000 + d * 86400000).toISOString().slice(0, 10);
const mk = (id, openingDate, score, over = {}) => ({ id, title: id, openingDate, score, rc: 20, category: 'broadway', type: 'play', isRevival: false, venue: 'V', people: [], ...over });
const target = mk('TARGET', TARGET_DATE, 90, { previewsStartDate: day(TARGET_DATE, -30) });

function setup(extraShows = [], audience = {}) {
  const pool = [];
  for (let i = 0; i < 12; i++) pool.push(mk(`b${i}`, day('2012-10-01', i * 20), 60 + (i % 4) * 5));
  const all = [...pool, ...extraShows, target];
  const poolById = Object.fromEntries(all.map((s) => [s.id, s]));
  const cast = (id, names) => ({ showId: id, openingNightCast: names.map((n, i) => ({ name: n, ibdbPersonId: `p${n}`, flags: i === 0 ? ['Broadway debut'] : [] })) });
  const files = [cast('TARGET', ['Ann', 'Bob']), cast('b1', ['Ann']), cast('b2', ['Bob'])];
  for (const s of extraShows) files.push(cast(s.id, ['Ann', 'Bob']));
  const dates = Object.fromEntries(all.map((s) => [s.id, s.openingDate]));
  return { pool: all.filter((s) => s.id !== 'TARGET'), poolById, castIndex: V2.buildCastIndex(files, dates), weeks: {}, audience };
}

test('cast: a later credit by the same actor never feeds the target', () => {
  const clean = V2.buildV2Features(target, setup());
  const later = mk('later', day(TARGET_DATE, 30), 5);
  const inLag = mk('inLag', day(TARGET_DATE, -(RF.LAG_DAYS - 1)), 5);
  const after = V2.buildV2Features(target, setup([later, inLag]));
  assert.deepEqual(after.x, clean.x);
  assert.ok(!after.provenance.some((p) => p.ref === 'later' || p.ref === 'inLag'));
  V2.assertNoLeakageV2(target, after.provenance);
  assert.ok(clean.provenance.some((p) => p.kind === 'cast-credit'), 'credits are recorded in provenance');
});

test('cast: a credit at exactly LAG_DAYS counts', () => {
  const ok = mk('okLag', day(TARGET_DATE, -RF.LAG_DAYS), 99);
  const f = V2.buildV2Features(target, setup([ok]));
  assert.ok(f.provenance.some((p) => p.ref === 'okLag'));
  V2.assertNoLeakageV2(target, f.provenance);
});

test('preview: week ending before opening counts, the week containing opening does not', () => {
  const row = (cap) => ({ capacity: cap, atp: 100, gross: 1e6 });
  const wk = (cap) => ({ TARGET: { ...row(cap), gross: 2e6 }, a: row(90), b: row(90), c: row(90), d: row(90), e: row(90) });
  const ctx = { ...setup(), weeks: { [day(TARGET_DATE, -8)]: wk(50), [day(TARGET_DATE, -1)]: wk(60), [TARGET_DATE]: wk(99) } };
  const f = V2.buildV2Features(target, ctx);
  assert.deepEqual(f.provenance.filter((p) => p.kind === 'gross-week').map((p) => p.date), [day(TARGET_DATE, -8), day(TARGET_DATE, -1)]);
  assert.ok(f.x.capSlope > 0 && f.x.grossRel !== 0);
  V2.assertNoLeakageV2(target, f.provenance);
});

test('audience: a capture dated before opening is used, one on/after is refused', () => {
  const okCap = { TARGET: { timestamp: '20150301120000', score: 80, reviewCount: 120 } };
  const f = V2.buildV2Features(target, setup([], okCap));
  assert.equal(f.has.audience, true);
  assert.equal(f.x.audScore, -5);
  V2.assertNoLeakageV2(target, f.provenance);
  for (const ts of ['20150312000000', '20150401000000']) {
    const g = V2.buildV2Features(target, setup([], { TARGET: { timestamp: ts, score: 99, reviewCount: 500 } }));
    assert.throws(() => V2.assertNoLeakageV2(target, g.provenance), /LEAKAGE\(v2\)/);
  }
});

test('assertNoLeakageV2 rejects later, undated, self-referencing inputs', () => {
  const f = V2.buildV2Features(target, setup());
  const bad = (p) => assert.throws(() => V2.assertNoLeakageV2(target, [...f.provenance, p]), /LEAKAGE\(v2\)/);
  bad({ kind: 'cast-credit', ref: 'x', date: day(TARGET_DATE, 1) });
  bad({ kind: 'cast-credit', ref: 'x', date: day(TARGET_DATE, -(RF.LAG_DAYS - 1)) });
  bad({ kind: 'cast-credit', ref: 'TARGET', date: '2000-01-01' });
  bad({ kind: 'gross-week', ref: 'TARGET@w', date: TARGET_DATE });
  bad({ kind: 'previews-start', ref: 'TARGET', date: null });
});

test('slope: increasing series positive, flat zero', () => {
  assert.ok(V2.slope([1, 2, 3, 4]) > 0);
  assert.equal(V2.slope([5, 5, 5]), 0);
  assert.equal(V2.slope([7]), 0);
});
