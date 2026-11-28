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

// --- BRO-8397: coverage stamp (covered.json) and slice prune ---
const cov = require('./coverage.js');
const prune = require('./prune.js');

test('coverageRecord: a verified publish of every changed show is complete', async () => {
  const f = fixture();
  const state = fakeState();
  const plan = f.planWith(null);
  const w = await writePublish({ storage: fakeStorage(), state, plan, manifest: { ...f.m, publicSha: 'p'.repeat(40) }, sliceFor: f.sliceFor, now: NOW });
  const dataShas = { 'reviews.json': 'r', 'shows.json': 's', 'critic-consensus.json': 'c' };
  const reval = { message: 'HTTP 200 for 2 show(s)', pending: [], abandoned: [] };
  const rec = cov.coverageRecord({ plan, head: { shows: f.headShows }, manifest: { ...f.m, publicSha: 'p'.repeat(40) }, writeResult: w, revalidate: reval, dataShas, now: NOW });
  assert.equal(rec.complete, true, rec.reasons.join('; '));
  assert.equal(rec.generation, homeOf(state).generation);
  assert.equal(rec.homeSig, cov.homeShowsSig(homeOf(state).shows), 'stamp signs exactly the home it verified');
  // The gate accepts that stamp against that home.
  assert.equal(cov.evaluateCoverage({
    readerOn: true, kill: { killed: false }, homeRead: { state: 'ok', value: homeOf(state) }, coveredRead: { state: 'ok', value: rec },
    nowShas: { 'reviews.json': 'r', 'shows.json': 's', 'critic-consensus.json': 'c' }, dataFiles: { changed: ['reviews.json'], unknown: [] }, baselineSha: 'p'.repeat(40),
  }).covered, true);
  // Each doubt flips it to incomplete.
  const mk = (o) => cov.coverageRecord({ plan, head: { shows: f.headShows }, manifest: f.m, writeResult: w, revalidate: reval, dataShas, now: NOW, ...o });
  assert.equal(mk({ writeResult: null }).complete, false, 'no write');
  assert.equal(mk({ writeResult: { ...w, outcome: OUTCOMES.CAS_LOST, generation: null } }).complete, false, 'cas lost');
  assert.equal(mk({ revalidate: { ...reval, pending: ['x'] } }).complete, false, 'revalidation queued');
  assert.equal(mk({ revalidate: { message: 'skipped (SHOW_REFRESH_REVALIDATE_SECRET unset)', pending: [], abandoned: [] } }).complete, false, 'no secret');
  assert.equal(mk({ dataShas: { ...dataShas, 'shows.json': null } }).complete, false, 'unknown data sha');
});

test('planCoverage: a reveal, a new show or a capped plan is not covered; unchanged and still-held are', () => {
  const f = fixture();
  const plan = f.planWith(null);
  assert.equal(cov.planCoverage({ plan, head: { shows: f.headShows } }).complete, true);
  const withSkips = (skips, extra = {}) => ({ ...plan, skips, ...extra });
  assert.equal(cov.planCoverage({ plan: withSkips({ z: 'unchanged' }), head: { shows: f.headShows } }).complete, true);
  assert.equal(cov.planCoverage({ plan: withSkips({ z: 'held-build' }), head: { shows: { ...f.headShows, z: hshow({ held: true }) } } }).complete, true, 'still held: invisible');
  assert.equal(cov.planCoverage({ plan: withSkips({ z: 'held-build' }), head: { shows: { ...f.headShows, z: hshow() } } }).complete, false, 'reveal needs a build');
  assert.equal(cov.planCoverage({ plan: withSkips({ z: 'images-changed' }), head: { shows: f.headShows } }).complete, false);
  assert.equal(cov.planCoverage({ plan: withSkips({}, { dirty: ['new-show'] }), head: { shows: f.headShows } }).complete, false);
  assert.equal(cov.planCoverage({ plan: { ...plan, outcome: OUTCOMES.CAP }, head: { shows: f.headShows } }).complete, false);
});

test('gitBlobSha matches git hash-object', async () => {
  const { execFileSync } = await import('node:child_process');
  const buf = Buffer.from('{"a":1}\n');
  const want = execFileSync('git', ['hash-object', '--stdin'], { input: buf, encoding: 'utf8' }).trim();
  assert.equal(cov.gitBlobSha(buf), want);
});

/** Storage with folder listing (Supabase list semantics) and bulk delete. */
function listingStorage(objects /* { path: createdMs } */) {
  const objs = new Map(Object.entries(objects).map(([p, t]) => [p, { text: '{}', created: t }]));
  const calls = { removeMany: [] };
  return {
    objs, calls,
    async get(path) { return objs.has(path) ? { status: 200, text: objs.get(path).text } : { status: 400, text: '{"statusCode":"404","error":"not_found"}' }; },
    async put(path, text) { objs.set(path, { text, created: NOW }); },
    async list(prefix, { limit, offset }) {
      const pre = `${prefix}/`;
      const names = new Map();
      for (const [p, o] of objs) {
        if (!p.startsWith(pre)) continue;
        const rest = p.slice(pre.length);
        const [head, ...more] = rest.split('/');
        if (more.length) names.set(head, { name: head, id: null });
        else names.set(head, { name: head, id: `id-${p}`, created_at: new Date(o.created).toISOString() });
      }
      return [...names.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(offset, offset + limit);
    },
    async removeMany(paths) { calls.removeMany.push(paths); for (const p of paths) objs.delete(p); return paths.map((name) => ({ name })); },
  };
}

const OLD = NOW - 30 * 24 * 3600e3;
function pruneFixture() {
  const home = {
    schema: 1, manifestId: 'm2', generation: 9,
    shows: { x: { hash: h('1') } },
    pending: { y: { since: NOW, expect: h('2') } },
    previousGenerations: [
      { schema: 1, manifestId: 'm2', generation: 8, shows: { x: { hash: h('3') } }, pending: {} },
      { schema: 1, manifestId: 'm1', generation: 7, shows: { x: { hash: h('4') } }, pending: {} },
    ],
  };
  const storage = listingStorage({
    [`show/x/${h('1')}.json`]: OLD, // current
    [`show/y/${h('2')}.json`]: OLD, // current pending expect
    [`show/x/${h('3')}.json`]: OLD, // previous generation 1
    [`show/x/${h('4')}.json`]: OLD, // previous generation 2
    [`show/x/${h('5')}.json`]: OLD, // unreferenced, old -> delete
    [`show/z/${h('6')}.json`]: OLD, // unreferenced, old -> delete
    [`show/z/${h('7')}.json`]: NOW - 3600e3, // unreferenced but young -> keep
    'show/z/README.txt': OLD, // unknown name -> keep
  });
  return { home, storage, state: fakeState({ home }) };
}

test('prune: referenced versions are kept, unreferenced old ones deleted', async () => {
  const { storage, state } = pruneFixture();
  const r = await prune.pruneSlices({ storage, state, now: NOW, dryRun: false });
  assert.equal(r.ran, true, r.why);
  assert.deepEqual(r.deleted.sort(), [`show/x/${h('5')}.json`, `show/z/${h('6')}.json`]);
  for (const kept of [h('1'), h('3'), h('4')]) assert.ok(storage.objs.has(`show/x/${kept}.json`), `kept ${kept}`);
  assert.ok(storage.objs.has(`show/y/${h('2')}.json`), 'pending expect kept');
  assert.ok(storage.objs.has(`show/z/${h('7')}.json`), 'young object kept');
  assert.ok(storage.objs.has('show/z/README.txt'), 'unknown name kept');
  assert.ok(storage.objs.has(store.PATHS.pruneLastRun), 'last-run stamp written');
  // keepGenerations=1 drops the oldest rollback generation.
  const f2 = pruneFixture();
  const r2 = await prune.pruneSlices({ storage: f2.storage, state: f2.state, now: NOW, dryRun: false, keepGenerations: 1 });
  assert.ok(r2.deleted.includes(`show/x/${h('4')}.json`));
  assert.ok(!r2.deleted.includes(`show/x/${h('3')}.json`));
});

test('prune: dry-run lists only, and the daily guard holds a second run', async () => {
  const { storage, state } = pruneFixture();
  const before = new Set(storage.objs.keys());
  const r = await prune.pruneSlices({ storage, state, now: NOW });
  assert.equal(r.dryRun, true);
  assert.deepEqual(r.deleted, []);
  assert.deepEqual(r.plan.toDelete.sort(), [`show/x/${h('5')}.json`, `show/z/${h('6')}.json`]);
  assert.equal(storage.calls.removeMany.length, 0);
  for (const p of before) assert.ok(storage.objs.has(p), `dry-run kept ${p}`);
  const again = await prune.pruneSlices({ storage, state, now: NOW + 3600e3, dryRun: false });
  assert.equal(again.ran, false);
  assert.match(again.why, /not due/);
  assert.equal(storage.calls.removeMany.length, 0);
  assert.equal((await prune.pruneSlices({ storage, state, now: NOW + 25 * 3600e3, dryRun: true })).ran, true, 'due again after a day');
});

test('prune: never deletes when home is unusable or moves mid-run', async () => {
  const bad = pruneFixture();
  bad.state.rows.set('home.json', JSON.stringify({ shows: {} }));
  const r = await prune.pruneSlices({ storage: bad.storage, state: bad.state, now: NOW, dryRun: false });
  assert.equal(r.ran, false);
  assert.equal(bad.storage.calls.removeMany.length, 0);
  const moving = pruneFixture();
  const origList = moving.storage.list;
  moving.storage.list = async (...a) => {
    moving.state.rows.set('home.json', JSON.stringify({ ...moving.home, generation: 10, shows: { x: { hash: h('5') } } }));
    return origList(...a);
  };
  const r2 = await prune.pruneSlices({ storage: moving.storage, state: moving.state, now: NOW, dryRun: false });
  assert.match(r2.why, /home moved/);
  assert.equal(moving.storage.calls.removeMany.length, 0);
  assert.ok(moving.storage.objs.has(`show/x/${h('5')}.json`));
  assert.equal(prune.pruneDue({ state: 'error', error: 'status 500' }, NOW).due, false, 'unreadable guard => skip');
});

test('prune wiring: workflow step is advisory, scheduled only and dry-run unless the variable says true', async () => {
  const fs = await import('node:fs');
  const y = fs.readFileSync(new URL('../../../.github/workflows/publish-show-refresh.yml', import.meta.url), 'utf8');
  const step = y.slice(y.indexOf('- name: Prune old show slices'), y.indexOf('- name: Upload report'));
  assert.match(step, /continue-on-error: true/);
  assert.match(step, /github\.event_name == 'schedule'/);
  assert.match(step, /SHOW_REFRESH_PRUNE_DELETE: \$\{\{ vars\.SHOW_REFRESH_PRUNE_DELETE \}\}/);
  assert.match(step, /node scripts\/lib\/show-refresh\/prune\.js/);
});

test('BRO-8397 review: unreadable or unsaved revalidate queue is never settled', () => {
  const ok = { message: 'revalidated 2', pending: [], abandoned: [], queueNote: 'read; saved' };
  assert.equal(cov.revalidateSettled(ok), true);
  for (const queueNote of ['read failed (500); queue left untouched', 'read; save failed: boom', 'no queue store']) {
    assert.equal(cov.revalidateSettled({ ...ok, queueNote }), false, queueNote);
  }
});

test('BRO-8397 review: prune refuses a home with no shows map', () => {
  assert.equal(!!prune.usableHome({ state: 'ok', value: { generation: 5 } }), false);
  assert.equal(!!prune.usableHome({ state: 'ok', value: { generation: 5, shows: [] } }), false);
  assert.equal(!!prune.usableHome({ state: 'ok', value: { generation: 5, shows: {} } }), true);
});

test('BRO-8397: a reused object the live home does not point at (content revert) is re-put so a prune skips it', async () => {
  const f = fixture();
  const storage = fakeStorage();
  // Both HEAD objects already exist (an older generation used them), but the live home points elsewhere.
  storage.objs.set(`show/x/${h('b')}.json`, JSON.stringify({ showId: 'x', n: 1 }));
  storage.objs.set(`show/y/${h('c')}.json`, JSON.stringify({ showId: 'y', n: 2 }));
  const prior = { ...store.HOME_PLACEHOLDER, generation: 3, manifestId: 'm1', shows: { x: { hash: h('d') }, y: { hash: h('c') } }, pending: {} };
  const state = fakeState({ home: prior });
  const r = await writePublish({ storage, state, plan: f.planWith(prior), manifest: f.m, sliceFor: f.sliceFor, now: NOW });
  assert.equal(r.outcome, WRITE_OUTCOMES.PUBLISHED);
  assert.deepEqual(r.touched, ['x'], 'only x: y is already referenced by the live home');
  assert.deepEqual(storage.calls.put, [`show/x/${h('b')}.json`]);
});

test('BRO-8397: a target deleted between the upload check and the swap is re-uploaded after the swap', async () => {
  const f = fixture();
  const storage = fakeStorage();
  const victim = `show/y/${h('c')}.json`;
  // A prune running in another concurrency group deletes y's object right before the CAS.
  const state = fakeState({ home: { ...store.HOME_PLACEHOLDER }, beforeCas: async () => { storage.objs.delete(victim); } });
  const r = await writePublish({ storage, state, plan: f.planWith(null), manifest: f.m, sliceFor: f.sliceFor, now: NOW });
  assert.equal(r.outcome, WRITE_OUTCOMES.PUBLISHED);
  assert.deepEqual(r.repaired, ['y']);
  assert.equal(storage.objs.get(victim), JSON.stringify({ showId: 'y', n: 2 }));
  assert.deepEqual(homeOf(state).shows.y, { hash: h('c') });
});

test('BRO-8397: a post-swap re-check error is logged, not thrown (the pointer is live; next run retries)', async () => {
  const f = fixture();
  const storage = fakeStorage();
  let swapped = false;
  const state = fakeState({ home: { ...store.HOME_PLACEHOLDER }, beforeCas: async () => { swapped = true; } });
  const realGet = storage.get.bind(storage);
  storage.get = async (p, o) => {
    if (swapped && p === `show/y/${h('c')}.json`) throw new Error('socket hang up');
    return realGet(p, o);
  };
  const r = await writePublish({ storage, state, plan: f.planWith(null), manifest: f.m, sliceFor: f.sliceFor, now: NOW });
  assert.equal(r.outcome, WRITE_OUTCOMES.PUBLISHED);
  assert.deepEqual(r.repairFailed, ['y']);
  assert.ok(r.log.some((l) => /WARNING: could not re-check show\/y\//.test(l)));
});

test('BRO-8397: prune deletes nothing while the kill switch is on or the kill row is missing', async () => {
  for (const kill of [{ schema: 1, killed: true, reason: 'drill', seq: 2 }, null]) {
    const { home, storage } = pruneFixture();
    const before = storage.objs.size;
    const r = await prune.pruneSlices({ storage, state: fakeState({ home, kill }), now: NOW, dryRun: false, force: true });
    assert.equal(r.ran, false);
    assert.match(r.why, /kill switch on/);
    assert.equal(storage.calls.removeMany.length, 0);
    assert.equal(storage.objs.size, before);
  }
});
