// BRO-8236: urgent deploy triggers ship now only on a visitor-visible reveal.
// Fixtures are real public/data/shows files from poller commit 15785a08d:
// sweeney-todd cs 79.65 -> 79.42 (displays 80 -> 79, a reveal) and
// be-more-chill cs 66.27 -> 65.67 (displays 66 both times, not a reveal).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { reviewProjection, classifyReveal, resolveUrgency, classifyRange, openingIdsFrom, nytPicksChanged, MAX_SHOW_FILES } = require('./deploy-reveal.js');
const { CODE_PATHS, URGENT_SOURCES, ALWAYS_SHIP_SOURCES, isUrgent } = require('./should-deploy-gate.js');

const fx = (n) => fs.readFileSync(new URL(`../../tests/fixtures/deploy-reveal/${n}.json`, import.meta.url), 'utf8');
const SHOW = 'public/data/shows/x.json';
const readOf = (before, after) => () => ({ before, after });

test('rounded critic score change is a reveal (sweeney-todd 80 -> 79)', () => {
  const r = classifyReveal([SHOW], readOf(fx('sweeney-before'), fx('sweeney-after')));
  assert.equal(r.reveal, true);
  assert.equal(r.reason, 'reviews-changed');
});

test('sub-integer score drift is not a reveal (be-more-chill 66.27 -> 65.67)', () => {
  const r = classifyReveal([SHOW], readOf(fx('bmc-before'), fx('bmc-after')));
  assert.equal(r.reveal, false);
});

test('new review, changed score, changed verdict, or count are reveals', () => {
  const b = JSON.parse(fx('bmc-before'));
  const mut = (f) => { const a = structuredClone(b); f(a); return classifyReveal([SHOW], readOf(JSON.stringify(b), JSON.stringify(a))).reveal; };
  assert.equal(mut((a) => a.rv.push({ o: 'New York Times', cn: 'X', s: 80, v: 'positive', u: 'https://nyt.example/r' })), true);
  assert.equal(mut((a) => { a.rv[0].s += 1; }), true);
  assert.equal(mut((a) => { a.rv[0].v = a.rv[0].v === 'negative' ? 'rave' : 'negative'; }), true);
  assert.equal(mut((a) => { a.rc = (a.rc || 0) + 1; }), true);
  // Quote text, review order and a regenerated critics' take are not reveals.
  assert.equal(mut((a) => { a.cn = { ...(a.cn || {}), t: 'new take' }; }), false);
  assert.equal(mut((a) => { a.rv[0].q = 'different excerpt'; }), false);
  assert.equal(mut((a) => { a.rv.reverse(); }), false);
});

test('added or deleted show file: reveal only when it has reviews', () => {
  const withRv = JSON.stringify({ id: 'x', rv: [{ u: 'u', s: 70, v: 'positive' }] });
  const empty = JSON.stringify({ id: 'x', rv: [] });
  assert.equal(classifyReveal([SHOW], readOf(null, withRv)).reason, 'show-added');
  assert.equal(classifyReveal([SHOW], readOf(withRv, null)).reason, 'show-deleted');
  assert.equal(classifyReveal([SHOW], readOf(null, empty)).reveal, false);
});

test('code paths and NYT picks are reveals; unrelated data is not', () => {
  assert.equal(classifyReveal(['src/app/page.tsx'], () => null, { codePaths: CODE_PATHS }).reason, 'code');
  assert.equal(classifyReveal(['package.json'], () => null, { codePaths: CODE_PATHS }).reason, 'code');
  assert.equal(classifyReveal(['data/nyt-critics-picks.json'], () => null).reason, 'nyt-picks');
  assert.equal(classifyReveal(['data/audit/x.json', 'public/status.html'], () => null, { codePaths: CODE_PATHS }).reveal, false);
});

test('every uncertainty fails open (reveal)', () => {
  assert.equal(classifyReveal([SHOW], () => { throw new Error('x'); }).reason, 'read-error');
  assert.equal(classifyReveal([SHOW], () => null).reason, 'read-error');
  assert.equal(classifyReveal([SHOW], readOf('{bad', '{}')).reason, 'parse-error');
  const many = Array.from({ length: MAX_SHOW_FILES + 1 }, (_, i) => `public/data/shows/s${i}.json`);
  assert.equal(classifyReveal(many, readOf('{}', '{}')).reveal, true);
  const r = classifyRange('no-such-sha-1', 'no-such-sha-2');
  assert.equal(r.reveal, true);
  assert.match(r.reason, /^classify-error/);
});

test('reviewProjection ignores sub-integer cs, keeps rounded cs', () => {
  assert.equal(reviewProjection({ cs: 69.06, rv: [] }), reviewProjection({ cs: 69.17, rv: [] }));
  assert.notEqual(reviewProjection({ cs: 69.4, rv: [] }), reviewProjection({ cs: 69.6, rv: [] }));
});

test('resolveUrgency: urgent trigger without a reveal is downgraded to routine', () => {
  const A = 'a'.repeat(40); const B = 'b'.repeat(40);
  const no = { reveal: false, reason: 'no-visible-change(3 show files)' };
  assert.equal(resolveUrgency({ urgent: true, alwaysShip: false, baselineSha: A, headSha: B, reveal: no }).urgent, false);
  assert.equal(resolveUrgency({ urgent: true, alwaysShip: false, baselineSha: A, headSha: B, reveal: { reveal: true, reason: 'code' } }).urgent, true);
  // Missing classification, unknown baseline, or HEAD already live: unchanged (urgent).
  assert.equal(resolveUrgency({ urgent: true, alwaysShip: false, baselineSha: A, headSha: B, reveal: null }).urgent, true);
  assert.equal(resolveUrgency({ urgent: true, alwaysShip: false, baselineSha: null, headSha: B, reveal: no }).urgent, true);
  assert.equal(resolveUrgency({ urgent: true, alwaysShip: false, baselineSha: A, headSha: A, reveal: no }).urgent, true);
  assert.equal(resolveUrgency({ urgent: true, alwaysShip: true, baselineSha: A, headSha: B, reveal: no }).urgent, true);
  assert.equal(resolveUrgency({ urgent: false, alwaysShip: false, baselineSha: A, headSha: B, reveal: { reveal: true } }).urgent, false);
});

test('opening-night-reveal is an urgent, always-ship source', () => {
  assert.ok(URGENT_SOURCES.includes('opening-night-reveal'));
  assert.ok(ALWAYS_SHIP_SOURCES.includes('opening-night-reveal'));
  assert.ok(ALWAYS_SHIP_SOURCES.includes('urgent'));
  assert.ok(!ALWAYS_SHIP_SOURCES.includes('opening-night'));
  assert.ok(!ALWAYS_SHIP_SOURCES.includes('rebuild-fast'));
  assert.equal(isUrgent({ eventName: 'workflow_dispatch', source: 'opening-night-reveal' }), true);
  assert.equal(isUrgent({ eventName: 'workflow_dispatch', source: 'opening-night-routine' }), false);
});

test('only shows in the opening window can reveal', () => {
  const b = fx('sweeney-before'); const a = fx('sweeney-after');
  assert.equal(classifyReveal([SHOW], readOf(b, a), { openingIds: ['other'] }).reveal, false);
  assert.equal(classifyReveal([SHOW], readOf(b, a), { openingIds: ['x'] }).reveal, true);
  assert.equal(classifyReveal([SHOW], readOf(b, a), { openingIds: null }).reveal, true); // unknown window fails open
  assert.deepEqual(openingIdsFrom(JSON.stringify({ shows: [{ id: 'a' }], upcoming: [{ id: 'b' }] })), ['a', 'b']);
  assert.equal(openingIdsFrom('{bad'), null);
  assert.equal(openingIdsFrom(null), null);
});

test('NYT picks: only the url list counts, _meta timestamp churn does not', () => {
  const p = (urls, ts) => JSON.stringify({ _meta: { lastUpdated: ts }, urls });
  const r = (before, after) => classifyReveal(['data/nyt-critics-picks.json'], () => ({ before, after }));
  assert.equal(r(p(['a'], 't1'), p(['a'], 't2')).reveal, false);
  assert.equal(r(p(['a'], 't1'), p(['a', 'b'], 't2')).reveal, true);
  assert.equal(r('{bad', p(['a'], 't2')).reveal, true);
  assert.equal(nytPicksChanged(null), true);
});

test('classifyRange on real poller commit 15785a08d: sweeney-todd reveal is outside the opening window', () => {
  const r = classifyRange('15785a08d~1', '15785a08d', { codePaths: CODE_PATHS });
  if (/classify-error/.test(r.reason)) return; // shallow CI checkout without this history
  assert.equal(r.reveal, false);
});

test('ship-check fixes: press-night sources always ship (private-only reveals)', () => {
  assert.ok(ALWAYS_SHIP_SOURCES.includes('lane-press-night'));
  assert.ok(ALWAYS_SHIP_SOURCES.includes('press-night-watchdog'));
});

test('ship-check fixes: empty or stale status file means unknown window (fail open)', () => {
  const st = (ids, gen) => JSON.stringify({ generatedAt: gen, shows: ids.map((id) => ({ id })), upcoming: [] });
  const now = Date.parse('2026-11-24T00:00:00Z') / 1000;
  assert.equal(openingIdsFrom(st([], '2026-11-23T23:00:00Z')), null);
  assert.deepEqual(openingIdsFrom(st(['a'], '2026-11-23T23:00:00Z'), { refEpochSec: now }), ['a']);
  assert.equal(openingIdsFrom(st(['a'], '2026-11-20T00:00:00Z'), { refEpochSec: now }), null);
  assert.equal(openingIdsFrom(st(['a'], undefined), { refEpochSec: now }), null);
});

test('ship-check fixes: first reviews for a show outside the window are a reveal', () => {
  const none = JSON.stringify({ _v: 4, id: 'x', rv: [] });
  const noKey = JSON.stringify({ _v: 4, id: 'x' });
  const one = JSON.stringify({ _v: 4, id: 'x', rv: [{ u: 'u', s: 70, v: 'positive' }] });
  const two = JSON.stringify({ _v: 4, id: 'x', rv: [{ u: 'u', s: 70, v: 'positive' }, { u: 'w', s: 60, v: 'mixed' }] });
  const opt = { openingIds: ['other'] };
  assert.equal(classifyReveal([SHOW], readOf(none, one), opt).reason, 'first-reviews');
  assert.equal(classifyReveal([SHOW], readOf(noKey, one), opt).reason, 'first-reviews');
  assert.equal(classifyReveal([SHOW], readOf(null, one), opt).reason, 'first-reviews');
  assert.equal(classifyReveal([SHOW], readOf(one, two), opt).reveal, false); // later review, routine
});

test('ship-check fixes: unknown show JSON shape or schema version change is a reveal', () => {
  const b = fx('bmc-before');
  const j = JSON.parse(b);
  const renamed = JSON.stringify({ ...j, rv: { list: j.rv } });
  const bumped = JSON.stringify({ ...j, _v: (j._v || 0) + 1 });
  assert.equal(classifyReveal([SHOW], readOf(b, renamed)).reason, 'schema-changed');
  assert.equal(classifyReveal([SHOW], readOf(b, bumped)).reason, 'schema-changed');
});
