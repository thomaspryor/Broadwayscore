/** BRO-7373: leakage + spec guards for the second input sweep. Run: node --test tests/unit/review-forecast-v2-sweep2.test.mjs */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const RF = require('../../scripts/lib/review-forecast.js');
const S2 = require('../../scripts/lib/review-forecast-v2-sweep2.js');

const T_DATE = '2020-03-20';
const target = { id: 'T', title: 'Target Show', openingDate: T_DATE, type: 'play', venue: 'Lyceum Theatre', category: 'broadway' };
const mk = (id, title, open, score, extra = {}) => ({ id, title, openingDate: open, type: 'play', category: 'broadway', score, rc: 20, ...extra });
const team = (names) => S2.teamOf(names.map(([name, role]) => ({ name, role })));
const ctxFor = (pool, teams) => ({ pool, poolById: new Map(pool.map((s) => [s.id, s])), teams: new Map(Object.entries(teams)), openings: [], weeks: {}, theaterSeats: {}, origins: {}, memberShape: {}, showMeta: {} });

test('teamOf splits director, book and music, and ignores support roles', () => {
  const t = team([['Ann Dir', 'Director'], ['Bo Writer', 'Playwright'], ['Cy Tune', 'Music & Lyrics'], ['Di Choreo', 'Choreographer'], ['Ed Sets', 'Scenic Designer'], ['Fay Mus', 'Music Supervisor']]);
  assert.deepEqual([...t.dir], ['ann dir']);
  assert.deepEqual([...t.book], ['bo writer']);
  assert.deepEqual([...t.music], ['cy tune']);
});

test('team record uses only earlier, other-title shows, shrunk toward zero', () => {
  const a = mk('a', 'Old One', '2018-01-10', 80); const b = mk('b', 'Old Two', '2019-01-10', 60);
  const same = mk('s', 'The Target Show', '2017-05-05', 99); // earlier production of the same title: BRO-7369's input, excluded
  const later = mk('l', 'Later', '2021-01-10', 10);
  const base = mk('base', 'Base', '2018-06-01', 70);
  const pool = [a, b, same, later, base];
  const dir = team([['Ann Dir', 'Director']]);
  const ctx = ctxFor(pool, { T: dir, a: dir, b: dir, s: dir, l: dir });
  const f = S2.buildSweep2Features(target, ctx, { floor: 10 });
  assert.ok(f.has.team);
  assert.equal(f.x.dirN, Math.log1p(2), 'two eligible credits (a, b); same-title and later shows do not count');
  S2.assertNoLeakageSweep2(target, f.provenance);
  assert.ok(!f.provenance.some((p) => p.ref === 's' || p.ref === 'l'));
  // a post-opening show changing its score changes nothing
  const ctx2 = ctxFor(pool.map((s) => (s.id === 'l' ? { ...s, score: 95 } : s)), { T: dir, a: dir, b: dir, s: dir, l: dir });
  assert.deepEqual(S2.buildSweep2Features(target, ctx2, { floor: 10 }).x, f.x);
});

test('assertNoLeakageSweep2 refuses undated, in-lag, self and post-opening inputs', () => {
  const bad = (p) => assert.throws(() => S2.assertNoLeakageSweep2(target, [p]), /LEAKAGE/);
  bad({ kind: 'team-credit', ref: 'x', date: null });
  bad({ kind: 'team-credit', ref: 'x', date: '2020-03-19' });
  bad({ kind: 'team-credit', ref: 'T', date: '2019-01-01' });
  bad({ kind: 'gross-week', ref: 'g', date: T_DATE });
  bad({ kind: 'member-shape', ref: 'T', date: '2020-03-21' });
  assert.ok(S2.assertNoLeakageSweep2(target, [{ kind: 'team-credit', ref: 'x', date: '2020-03-10' }, { kind: 'static-origin', ref: 'T' }, { kind: 'member-shape', ref: 'T', date: '2020-03-19' }]));
});

test('feature names in the groups are exactly the names the builder emits', () => {
  const f = S2.buildSweep2Features(target, ctxFor([], {}), { floor: 10 });
  assert.deepEqual(Object.keys(f.x).sort(), [...S2.SWEEP2_FEATURE_NAMES].sort());
  assert.deepEqual(Object.values(S2.SWEEP2_GROUPS).flat().sort(), [...S2.SWEEP2_FEATURE_NAMES].sort());
});
