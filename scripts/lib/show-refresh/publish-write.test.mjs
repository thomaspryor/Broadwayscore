// Tests for scripts/lib/show-refresh/publish-write.js (BRO-8214 phase 3a, "Test it well"):
// idempotent re-run, overlapping runs (CAS), partial failure keeps the old
// pointer, kill stops the run, held shows never uploaded.
// Run: node --test scripts/lib/show-refresh/publish-write.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { writePublish, WRITE_OUTCOMES } = require('./publish-write.js');
const { planPublish, OUTCOMES } = require('./publish-plan.js');
const store = require('./store.js');

const NOW = Date.UTC(2026, 10, 24, 12, 0);
const h = (c) => c.repeat(16);

/** In-memory Storage: get/put like live-score/storage.js. */
function fakeStorage({ failPutOn } = {}) {
  const objs = new Map();
  const calls = { put: [] };
  return {
    objs, calls,
    async get(path) {
      await Promise.resolve();
      return objs.has(path) ? { status: 200, text: objs.get(path) } : { status: 400, text: '{"statusCode":"404","error":"not_found","message":"Object not found"}' };
    },
    async put(path, text) {
      await Promise.resolve();
      calls.put.push(path);
      if (failPutOn && failPutOn(path)) throw new Error(`storage put ${path} 503`);
      objs.set(path, text);
    },
  };
}

/** In-memory state table with the PostgREST CAS semantics of makeStateTable. */
function fakeState({ home, kill = { schema: 1, killed: false, seq: 1 }, failCas = false, beforeCas } = {}) {
  const rows = new Map();
  if (home !== undefined) rows.set('home.json', JSON.stringify(home));
  if (kill !== null) rows.set('kill.json', JSON.stringify(kill));
  const calls = { cas: 0, insert: 0 };
  return {
    rows, calls,
    async get(path) { await Promise.resolve(); return rows.has(path) ? { status: 200, text: rows.get(path) } : { status: 404, text: '' }; },
    async put(path, text) { rows.set(path, text); },
    async insertIfAbsent(path, text) { calls.insert++; if (rows.has(path)) return 0; rows.set(path, text); return 1; },
    async putIfField(path, text, field, expect) {
      calls.cas++;
      if (beforeCas) await beforeCas();
      if (failCas) throw new Error('state putIfField home.json 500');
      const cur = rows.has(path) ? JSON.parse(rows.get(path)) : null;
      if (!cur || String(cur[field]) !== String(expect)) return 0;
      rows.set(path, text);
      return 1;
    },
  };
}
const homeOf = (st) => JSON.parse(st.rows.get('home.json'));

const manifest = (shows) => ({
  schema: 1, sliceVersion: 1, manifestId: 'm1', buildInstant: NOW - 3600e3, buildDate: '2026-11-24', registrySha: 'reg', coreSha: 'core1',
  dataShas: { 'shows.json': 'z' }, showCount: Object.keys(shows).length, shows,
});
const mshow = (o = {}) => ({ slug: 's', hash: h('a'), held: false, imagesSig: 'img', reviewCount: 2, reviewsSig: 'sig', ...o });
const hshow = (o = {}) => ({ hash: h('b'), held: false, imagesSig: 'img', reviewCount: 2, reviewsSig: 'sig', ...o });

/** Two changed shows x, y (build hash a -> HEAD hash b / c). */
function fixture() {
  const m = manifest({ x: mshow({ slug: 'x' }), y: mshow({ slug: 'y' }) });
  const headShows = { x: hshow({ slug: 'x' }), y: hshow({ hash: h('c'), slug: 'y' }) };
  const slices = { x: { showId: 'x', n: 1 }, y: { showId: 'y', n: 2 } };
  const sliceFor = (id) => ({ slice: slices[id], hash: headShows[id].hash, held: false });
  const planWith = (prevHome) => planPublish({ manifest: m, head: { registrySha: 'reg', sliceVersion: 1, shows: headShows }, prevHome, now: NOW });
  return { m, headShows, sliceFor, planWith };
}

test('first publish: uploads both slices, seeds then swaps home to generation 1', async () => {
  const f = fixture();
  const storage = fakeStorage();
  const state = fakeState();
  const r = await writePublish({ storage, state, plan: f.planWith(null), manifest: f.m, sliceFor: f.sliceFor, now: NOW });
  assert.equal(r.outcome, WRITE_OUTCOMES.PUBLISHED);
  assert.deepEqual(r.uploaded.sort(), ['x', 'y']);
  assert.equal(state.calls.insert, 1);
  const home = homeOf(state);
  assert.equal(home.generation, 1);
  assert.equal(home.manifestId, 'm1');
  assert.equal(home.coreSha, 'core1');
  assert.deepEqual(home.shows, { x: { hash: h('b') }, y: { hash: h('c') } });
  assert.deepEqual(Object.keys(home.pending).sort(), ['x', 'y']);
  assert.equal(storage.objs.get(`show/x/${h('b')}.json`), JSON.stringify({ showId: 'x', n: 1 }));
  assert.deepEqual(r.changedIds, ['x', 'y']);
});

test('idempotent re-run: no new objects, no pointer change', async () => {
  const f = fixture();
  const storage = fakeStorage();
  const state = fakeState();
  await writePublish({ storage, state, plan: f.planWith(null), manifest: f.m, sliceFor: f.sliceFor, now: NOW });
  const putsAfterFirst = storage.calls.put.length;
  const homeText = state.rows.get('home.json');
  // The next scheduled run plans against the home it now reads.
  const plan2 = f.planWith(homeOf(state));
  assert.equal(plan2.outcome, OUTCOMES.NOTHING_TO_DO);
  const r2 = await writePublish({ storage, state, plan: plan2, manifest: f.m, sliceFor: f.sliceFor, now: NOW + 600e3 });
  assert.equal(r2.outcome, WRITE_OUTCOMES.UNCHANGED);
  assert.deepEqual(r2.uploaded, []);
  assert.deepEqual(r2.existing.sort(), ['x', 'y']);
  assert.equal(storage.calls.put.length, putsAfterFirst, 'no new uploads');
  assert.equal(state.rows.get('home.json'), homeText, 'pointer untouched, generation and publishedAt unchanged');
  assert.equal(state.calls.cas, 1, 'no second CAS');
});

test('overlapping runs: both read generation 0, exactly one swaps, the other reports cas-lost and changes nothing', async () => {
  const f = fixture();
  const storage = fakeStorage();
  // Barrier: neither run may CAS until both have reached the CAS, so both planned on generation 0.
  let arrived = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const state = fakeState({ home: { ...store.HOME_PLACEHOLDER }, beforeCas: async () => { arrived++; if (arrived === 2) release(); await gate; } });
  const plan = f.planWith(null);
  const [a, b] = await Promise.all([
    writePublish({ storage, state, plan, manifest: f.m, sliceFor: f.sliceFor, now: NOW }),
    writePublish({ storage, state, plan, manifest: f.m, sliceFor: f.sliceFor, now: NOW + 1 }),
  ]);
  const outcomes = [a.outcome, b.outcome].sort();
  assert.deepEqual(outcomes, [OUTCOMES.CAS_LOST, WRITE_OUTCOMES.PUBLISHED].sort());
  const home = homeOf(state);
  assert.equal(home.generation, 1, 'one swap only');
  const winner = a.outcome === WRITE_OUTCOMES.PUBLISHED ? a : b;
  assert.equal(home.generation, winner.generation);
  assert.deepEqual(home.shows, { x: { hash: h('b') }, y: { hash: h('c') } }, 'pointer is a complete, valid home');
});

test('a stale writer (planned on an older generation) cannot overwrite a newer pointer', async () => {
  const f = fixture();
  const storage = fakeStorage();
  const newer = { ...store.HOME_PLACEHOLDER, manifestId: 'm1', generation: 7, shows: { x: { hash: h('d') } }, pending: {} };
  const state = fakeState({ home: newer });
  // Simulate a home that moves between this run's read and its CAS.
  const orig = state.putIfField;
  state.putIfField = async (...args) => { state.rows.set('home.json', JSON.stringify({ ...newer, generation: 8 })); return orig(...args); };
  const r = await writePublish({ storage, state, plan: f.planWith(newer), manifest: f.m, sliceFor: f.sliceFor, now: NOW });
  assert.equal(r.outcome, OUTCOMES.CAS_LOST);
  assert.equal(homeOf(state).generation, 8);
  assert.deepEqual(homeOf(state).shows, { x: { hash: h('d') } });
});

test('home moved between planning and writing: stop before any upload', async () => {
  const f = fixture();
  const storage = fakeStorage();
  const state = fakeState({ home: { ...store.HOME_PLACEHOLDER, manifestId: 'm1', generation: 4 } });
  const r = await writePublish({ storage, state, plan: f.planWith(null), manifest: f.m, sliceFor: f.sliceFor, expectGeneration: 3, now: NOW });
  assert.equal(r.outcome, OUTCOMES.CAS_LOST);
  assert.equal(storage.calls.put.length, 0);
  assert.equal(homeOf(state).generation, 4);
  // Absent at planning (null) and seeded since: placeholder generation 0 matches.
  const r2 = await writePublish({ storage, state: fakeState(), plan: f.planWith(null), manifest: f.m, sliceFor: f.sliceFor, expectGeneration: null, now: NOW });
  assert.equal(r2.outcome, WRITE_OUTCOMES.PUBLISHED);
});

test('partial failure: an upload fails partway, the old pointer stays in place', async () => {
  const f = fixture();
  const old = { ...store.HOME_PLACEHOLDER, manifestId: 'm1', generation: 3, shows: {}, pending: {} };
  const storage = fakeStorage({ failPutOn: (p) => p.startsWith('show/y/') });
  const state = fakeState({ home: old });
  await assert.rejects(writePublish({ storage, state, plan: f.planWith(old), manifest: f.m, sliceFor: f.sliceFor, now: NOW }), /storage put show\/y/);
  assert.deepEqual(homeOf(state), old);
  assert.equal(state.calls.cas, 0);
});

test('partial failure: the pointer write itself errors, the old pointer stays in place', async () => {
  const f = fixture();
  const old = { ...store.HOME_PLACEHOLDER, manifestId: 'm1', generation: 3, shows: {}, pending: {} };
  const state = fakeState({ home: old, failCas: true });
  await assert.rejects(writePublish({ storage: fakeStorage(), state, plan: f.planWith(old), manifest: f.m, sliceFor: f.sliceFor, now: NOW }), /putIfField/);
  assert.deepEqual(homeOf(state), old);
});

test('kill switch: killed before the run => no upload, no pointer write', async () => {
  const f = fixture();
  const storage = fakeStorage();
  const old = { ...store.HOME_PLACEHOLDER, generation: 2 };
  const state = fakeState({ home: old, kill: { schema: 1, killed: true, reason: 'test', seq: 5 } });
  const r = await writePublish({ storage, state, plan: f.planWith(null), manifest: f.m, sliceFor: f.sliceFor, now: NOW });
  assert.equal(r.outcome, OUTCOMES.KILLED);
  assert.equal(storage.calls.put.length, 0);
  assert.equal(state.calls.cas, 0);
  assert.deepEqual(homeOf(state), old);
});

test('kill switch: a kill flipped during uploads stops the pointer swap', async () => {
  const f = fixture();
  const state = fakeState({ home: { ...store.HOME_PLACEHOLDER } });
  const storage = fakeStorage();
  const origPut = storage.put;
  storage.put = async (p, t) => { state.rows.set('kill.json', JSON.stringify({ schema: 1, killed: true, seq: 9 })); return origPut(p, t); };
  const r = await writePublish({ storage, state, plan: f.planWith(null), manifest: f.m, sliceFor: f.sliceFor, now: NOW });
  assert.equal(r.outcome, OUTCOMES.KILLED);
  assert.equal(state.calls.cas, 0);
  assert.equal(homeOf(state).generation, 0);
});

test('unreadable kill state fails closed (treated as killed)', async () => {
  const f = fixture();
  const state = fakeState({ home: { ...store.HOME_PLACEHOLDER } });
  state.rows.set('kill.json', 'not json');
  const storage = fakeStorage();
  const r = await writePublish({ storage, state, plan: f.planWith(null), manifest: f.m, sliceFor: f.sliceFor, now: NOW });
  assert.equal(r.outcome, OUTCOMES.KILLED);
  assert.equal(storage.calls.put.length, 0);
});

test('a missing kill row fails closed (treated as killed)', async () => {
  const f = fixture();
  const storage = fakeStorage();
  const state = fakeState({ kill: null });
  const r = await writePublish({ storage, state, plan: f.planWith(null), manifest: f.m, sliceFor: f.sliceFor, now: NOW });
  assert.equal(r.outcome, OUTCOMES.KILLED);
  assert.equal(storage.calls.put.length, 0);
});

test('a held show is never uploaded', async () => {
  const f = fixture();
  const storage = fakeStorage();
  const state = fakeState();
  const sliceFor = (id) => ({ ...f.sliceFor(id), held: id === 'y' });
  await assert.rejects(writePublish({ storage, state, plan: f.planWith(null), manifest: f.m, sliceFor, now: NOW }), /held show y/);
  assert.ok(!storage.calls.put.some((p) => p.startsWith('show/y/')));
});

test('same hash, different stored bytes is a hard error (no silent overwrite)', async () => {
  const f = fixture();
  const storage = fakeStorage();
  storage.objs.set(`show/x/${h('b')}.json`, '{"tampered":true}');
  await assert.rejects(writePublish({ storage, state: fakeState(), plan: f.planWith(null), manifest: f.m, sliceFor: f.sliceFor, now: NOW }), /differs from HEAD slice/);
});

test('unreadable home aborts before any write', async () => {
  const f = fixture();
  const storage = fakeStorage();
  const state = fakeState();
  const origGet = state.get;
  state.get = async (p) => (p === 'home.json' ? { status: 500, text: 'boom' } : origGet(p));
  await assert.rejects(writePublish({ storage, state, plan: f.planWith(null), manifest: f.m, sliceFor: f.sliceFor, now: NOW }), /home unreadable/);
  assert.equal(storage.calls.put.length, 0);
});

test('plans with nothing to write (manifest-unusable) write nothing', async () => {
  const storage = fakeStorage();
  const state = fakeState();
  const r = await writePublish({ storage, state, plan: { outcome: OUTCOMES.MANIFEST_UNUSABLE, nextHome: null, targets: [] }, manifest: {}, sliceFor: () => undefined, now: NOW });
  assert.equal(r.outcome, OUTCOMES.MANIFEST_UNUSABLE);
  assert.equal(storage.calls.put.length, 0);
  assert.equal(state.calls.cas + state.calls.insert, 0);
});

test('another run swapping right after our CAS is not an error (our pointer was written)', async () => {
  const f = fixture();
  const old = { ...store.HOME_PLACEHOLDER, manifestId: 'm1', generation: 3, shows: {}, pending: {} };
  const state = fakeState({ home: old });
  const orig = state.putIfField;
  state.putIfField = async (...args) => {
    const n = await orig(...args);
    state.rows.set('home.json', JSON.stringify({ ...JSON.parse(state.rows.get('home.json')), generation: 5 }));
    return n;
  };
  const r = await writePublish({ storage: fakeStorage(), state, plan: f.planWith(old), manifest: f.m, sliceFor: f.sliceFor, expectGeneration: 3, now: NOW });
  assert.equal(r.outcome, WRITE_OUTCOMES.PUBLISHED);
  assert.equal(r.generation, 4);
  assert.match(r.log.join('\n'), /moved it to 5/);
});

test('a read-back mismatch after a CAS that matched says the NEW pointer is live (pointerSwapped)', async () => {
  const f = fixture();
  const old = { ...store.HOME_PLACEHOLDER, manifestId: 'm1', generation: 3, shows: {}, pending: {} };
  const state = fakeState({ home: old });
  const orig = state.putIfField;
  state.putIfField = async (...args) => {
    const n = await orig(...args);
    state.rows.set('home.json', JSON.stringify({ ...JSON.parse(state.rows.get('home.json')), shows: {} }));
    return n;
  };
  await assert.rejects(
    writePublish({ storage: fakeStorage(), state, plan: f.planWith(old), manifest: f.m, sliceFor: f.sliceFor, expectGeneration: 3, now: NOW }),
    (e) => e.pointerSwapped === true && /swapped to generation 4/.test(e.message),
  );
});

test('each successful home swap retains a bounded rollback history of complete prior generations', async () => {
  const f = fixture();
  const prior = { ...store.HOME_PLACEHOLDER, generation: 7, manifestId: 'm1', shows: { x: { hash: h('d') } }, pending: {} };
  const state = fakeState({ home: prior });
  const storage = fakeStorage();
  const r = await writePublish({ storage, state, plan: f.planWith(prior), manifest: f.m, sliceFor: f.sliceFor, now: NOW });
  assert.equal(r.outcome, WRITE_OUTCOMES.PUBLISHED);
  assert.deepEqual(homeOf(state).previousGenerations, [prior]);
});

test('rollback history is limited to two prior generations without nesting', async () => {
  const f = fixture();
  const old = (generation) => ({ ...store.HOME_PLACEHOLDER, generation, manifestId: 'm1', shows: { x: { hash: h('d') } } });
  const prior = { ...old(7), previousGenerations: [old(6), old(5)] };
  const state = fakeState({ home: prior });
  await writePublish({ storage: fakeStorage(), state, plan: f.planWith(prior), manifest: f.m, sliceFor: f.sliceFor, now: NOW });
  const history = homeOf(state).previousGenerations;
  assert.deepEqual(history.map((v) => v.generation), [7, 6]);
  assert.equal('previousGenerations' in history[0], false);
});
