/**
 * BRO-8056: the show-refresh store (private Storage bucket for slices, the
 * show_refresh_state table for the mutable home/kill pointers) and the shared
 * storage client, run against a local fake of the Supabase Storage and
 * PostgREST endpoints. The fake mirrors the RLS policies of
 * supabase/migrations/20261123b_show_refresh_state.sql: the anon key reads
 * show/ objects and the home/kill/probe rows only, and can write nothing.
 * Requires the real modules (CLAUDE.md rule 15).
 * Card VERIFY: node --test tests/unit/show-refresh-store.test.mjs
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { makeStorage, putVerified } = require('../../scripts/lib/live-score/storage.js');
const store = require('../../scripts/lib/show-refresh/store.js');

const KEY = 'service-key-test';
const ANON = 'anon-key-test';
const STATE_ROW_KEYS = ['home', 'kill', 'probe']; // the table's CHECK
const ANON_ROWS = ['home', 'kill', 'probe']; // the anon SELECT policy

function startFake() {
  const state = {
    buckets: new Map(), objects: new Map(), headers: new Map(), rows: new Map(),
    failNext: 0, hangNext: 0, staleAnonRows: false, anonRowCache: new Map(), requests: [],
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const body = Buffer.concat(chunks).toString('utf8');
      state.requests.push({ method: req.method, path: url.pathname, auth: req.headers.authorization || '' });
      const done = (code, text = '') => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(text); };
      if (state.hangNext > 0) { state.hangNext--; return; } // never answers
      if (state.failNext > 0) { state.failNext--; return done(500, '{"error":"boom"}'); }
      const authed = req.headers.authorization === `Bearer ${KEY}`;
      const anon = req.headers.authorization === `Bearer ${ANON}`;
      let m;
      // PostgREST: public.show_refresh_state
      if (url.pathname === '/rest/v1/show_refresh_state') {
        const k = (url.searchParams.get('key') || '').replace(/^eq\./, '');
        if (req.method === 'GET') {
          if (!authed && !anon) return done(401);
          if (anon && !ANON_ROWS.includes(k)) return done(200, '[]');
          if (anon && state.staleAnonRows && state.anonRowCache.has(k)) return done(200, state.anonRowCache.get(k));
          const out = state.rows.has(k) ? JSON.stringify([{ value: state.rows.get(k) }]) : '[]';
          if (anon) state.anonRowCache.set(k, out);
          return done(200, out);
        }
        if (!authed) return done(401, '{"code":"42501","message":"permission denied for table show_refresh_state"}');
        if (req.method === 'POST') {
          const row = JSON.parse(body);
          if (!STATE_ROW_KEYS.includes(row.key)) return done(400, '{"code":"23514"}');
          // jsonb reorders keys: store with keys sorted so callers cannot rely on text equality.
          const sorted = Object.fromEntries(Object.keys(row.value).sort().reverse().map((x) => [x, row.value[x]]));
          state.rows.set(row.key, sorted);
          return done(201, '');
        }
        if (req.method === 'DELETE') {
          const had = state.rows.has(k) ? [{ key: k }] : [];
          state.rows.delete(k);
          return done(200, JSON.stringify(had));
        }
      }
      const p = url.pathname.replace(/^\/storage\/v1/, '');
      if (p === '/bucket' && req.method === 'POST') {
        if (!authed) return done(401);
        const b = JSON.parse(body);
        if (state.buckets.has(b.id)) return done(409, '{"message":"The resource already exists"}');
        state.buckets.set(b.id, { id: b.id, name: b.name, public: b.public });
        return done(200, JSON.stringify({ name: b.id }));
      }
      if ((m = p.match(/^\/bucket\/([^/]+)$/)) && req.method === 'GET') {
        return state.buckets.has(m[1]) ? done(200, JSON.stringify(state.buckets.get(m[1]))) : done(400, '{"statusCode":"404","error":"Bucket not found"}');
      }
      const notFound = '{"statusCode":"404","error":"not_found","message":"Object not found"}';
      if ((m = p.match(/^\/object\/authenticated\/([^/]+)\/(.+)$/)) && req.method === 'GET') {
        const key = `${m[1]}/${m[2]}`;
        if (!authed && !(anon && m[1] === 'show-refresh' && /^show\/[^/]/.test(m[2]))) return done(400, notFound); // RLS hides it
        return state.objects.has(key) ? done(200, state.objects.get(key)) : done(400, notFound);
      }
      if ((m = p.match(/^\/object\/public\/([^/]+)\/(.+)$/)) && req.method === 'GET') {
        const b = state.buckets.get(m[1]);
        const key = `${m[1]}/${m[2]}`;
        if (b && b.public === false) return done(400, '{"statusCode":"404"}');
        return state.objects.has(key) ? done(200, state.objects.get(key)) : done(400, '{"statusCode":"404"}');
      }
      if ((m = p.match(/^\/object\/([^/]+)\/(.+)$/))) {
        const key = `${m[1]}/${m[2]}`;
        if (req.method === 'POST') {
          if (!authed) return done(400, '{"statusCode":"403","error":"Unauthorized","message":"new row violates row-level security policy"}');
          state.objects.set(key, body); state.headers.set(key, req.headers['cache-control']); return done(200, '{}');
        }
        if (req.method === 'DELETE') {
          if (!authed) return done(200, '[]'); // RLS filters the delete to nothing
          state.objects.delete(key); return done(200, '{}');
        }
      }
      return done(400, '{"statusCode":"400"}');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ baseUrl: `http://127.0.0.1:${server.address().port}`, state, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) })));
}

let fake;
before(async () => { fake = await startFake(); });
after(async () => { await fake.close(); });
const env = () => ({ SUPABASE_URL: fake.baseUrl, SUPABASE_SERVICE_ROLE_KEY: KEY, NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON });
const reset = () => {
  const s = fake.state;
  s.buckets.clear(); s.objects.clear(); s.headers.clear(); s.rows.clear(); s.anonRowCache.clear();
  s.failNext = 0; s.hangNext = 0; s.staleAnonRows = false;
};
const writer = () => ({ storage: store.storeFromEnv(env()), state: store.stateFromEnv(env()) });
const reader = () => ({ storage: store.readerStoreFromEnv(env()), state: store.readerStateFromEnv(env()) });
const setup = async () => { const w = writer(); await store.setupStore(w.storage, w.state, { by: 'test' }); return w; };

describe('storage client (shared with live-scores)', () => {
  test('public bucket default is unchanged: put + public read, max-age from cacheSeconds', async () => {
    reset();
    const s = makeStorage({ baseUrl: fake.baseUrl, serviceKey: KEY });
    assert.equal(await s.ensureBucket(), 'created');
    assert.equal(fake.state.buckets.get('live-scores').public, true);
    await putVerified(s, 'p.json', '{"a":1}', { cacheSeconds: 20 });
    assert.equal(fake.state.headers.get('live-scores/p.json'), 'max-age=20');
    const r = await s.get('p.json');
    assert.equal(r.status, 200);
    assert.equal(fake.state.requests.at(-1).path, '/storage/v1/object/public/live-scores/p.json');
  });

  test('cacheControl wins over cacheSeconds', async () => {
    reset();
    const s = makeStorage({ baseUrl: fake.baseUrl, serviceKey: KEY });
    await s.put('x.json', '{}', { cacheSeconds: 20, cacheControl: 'no-cache' });
    assert.equal(fake.state.headers.get('live-scores/x.json'), 'no-cache');
  });

  test('putVerified throws when the read-back differs', async () => {
    reset();
    const s = makeStorage({ baseUrl: fake.baseUrl, serviceKey: KEY });
    const lying = { ...s, get: async () => ({ status: 200, text: 'other' }) };
    await assert.rejects(putVerified(lying, 'a.json', 'mine'), /verify mismatch/);
  });

  test('timeoutMs aborts a request that never answers', async () => {
    reset();
    const s = makeStorage({ baseUrl: fake.baseUrl, serviceKey: KEY, bucket: 'b', isPublic: false, timeoutMs: 200 });
    fake.state.hangNext = 1;
    const t0 = Date.now();
    await assert.rejects(s.get('home.json'), /abort|timeout/i);
    assert.ok(Date.now() - t0 < 3000, 'gave up quickly');
  });
});


describe('show-refresh store', () => {
  test('showObjectPath validates id and hash', () => {
    assert.equal(store.showObjectPath('hamilton-2015', '0123456789abcdef'), 'show/hamilton-2015/0123456789abcdef.json');
    assert.throws(() => store.showObjectPath('../etc', '0123456789abcdef'), /bad show id/);
    assert.throws(() => store.showObjectPath('a', 'xyz'), /bad slice hash/);
    assert.throws(() => store.showObjectPath('Hamilton', '0123456789abcdef'), /bad show id/);
  });

  test('clients from env need the URL and the right key', () => {
    assert.throws(() => store.storeFromEnv({}), /required/);
    assert.throws(() => store.storeFromEnv({ SUPABASE_URL: 'http://x' }), /SERVICE_ROLE_KEY are required/);
    assert.throws(() => store.stateFromEnv({ SUPABASE_URL: 'http://x' }), /SERVICE_ROLE_KEY are required/);
    assert.throws(() => store.readerStateFromEnv({ SUPABASE_URL: 'http://x', SUPABASE_SERVICE_ROLE_KEY: KEY }), /ANON_KEY are required/, 'the reader never falls back to the service key');
    assert.throws(() => store.readerStoreFromEnv({ SUPABASE_URL: 'http://x', SUPABASE_SERVICE_ROLE_KEY: KEY }), /ANON_KEY are required/);
    const s = store.storeFromEnv(env());
    assert.equal(s.bucket, 'show-refresh');
    assert.equal(s.isPublic, false);
  });

  test('isReaderPath mirrors the storage RLS policy: show/ only', () => {
    assert.equal(store.isReaderPath('show/wicked-2003/0123456789abcdef.json'), true);
    for (const p of ['home.json', 'kill.json', 'covered.json', 'health.json', 'flagged/x.json', 'show/', 'shows/x.json']) {
      assert.equal(store.isReaderPath(p), false, p);
    }
  });

  test('the migration policies match STATE_KEYS and isReaderPath', () => {
    const fs = require('node:fs');
    const sql = fs.readFileSync(new URL('../../supabase/migrations/20261123b_show_refresh_state.sql', import.meta.url), 'utf8');
    const keys = Object.values(store.STATE_KEYS).sort();
    const list = (re) => sql.match(re)[1].split(',').map((x) => x.trim().replace(/'/g, '')).sort();
    assert.deepEqual(list(/CHECK \(key IN \(([^)]*)\)\)/), keys);
    assert.deepEqual(list(/FOR SELECT TO anon USING \(key IN \(([^)]*)\)\)/), keys);
    assert.match(sql, /bucket_id = 'show-refresh' AND \(storage\.foldername\(name\)\)\[1\] = 'show'/);
    assert.doesNotMatch(sql, /GRANT (INSERT|UPDATE|DELETE|ALL)[^;]*TO anon/);
  });

  test('setupStore creates a private bucket, seeds the kill + home rows, and is idempotent', async () => {
    reset();
    const w = writer();
    const first = await store.setupStore(w.storage, w.state, { by: 'test' });
    assert.equal(first.bucket, 'created');
    assert.deepEqual(first.seeded.sort(), ['home', 'kill']);
    assert.equal(fake.state.buckets.get('show-refresh').public, false);
    assert.equal(fake.state.rows.get('kill').killed, false);
    assert.equal(fake.state.rows.get('kill').seq, 1);
    assert.deepEqual(fake.state.rows.get('home'), store.HOME_PLACEHOLDER);
    assert.equal(fake.state.objects.size, 0, 'nothing mutable goes to Storage');
    const again = await store.setupStore(w.storage, w.state);
    assert.equal(again.bucket, 'exists');
    assert.deepEqual(again.seeded, []);
    assert.equal(fake.state.rows.get('kill').seq, 1, 'setup never rewrites an existing kill row');
  });

  test('setupStore refuses a bucket that is public', async () => {
    reset();
    fake.state.buckets.set('show-refresh', { id: 'show-refresh', public: true });
    const w = writer();
    await assert.rejects(store.setupStore(w.storage, w.state), /public; it must be private/);
    assert.equal(fake.state.rows.size, 0);
  });

  test('readJsonObject tells ok / missing / error apart, on both clients', async () => {
    reset();
    const w = await setup();
    assert.equal((await store.readJsonObject(w.state, 'home.json')).state, 'ok');
    assert.equal((await store.readJsonObject(w.state, 'probe.json')).state, 'missing');
    assert.equal((await store.readJsonObject(w.storage, 'covered.json')).state, 'missing');
    fake.state.failNext = 1;
    assert.equal((await store.readJsonObject(w.state, 'home.json')).state, 'error');
    fake.state.objects.set('show-refresh/health.json', 'not json');
    assert.equal((await store.readJsonObject(w.storage, 'health.json')).state, 'error');
    const down = store.stateFromEnv({ SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SERVICE_ROLE_KEY: KEY });
    assert.equal((await store.readJsonObject(down, 'home.json')).state, 'error');
    assert.equal((await store.readJsonObject(w.state, 'covered.json')).state, 'error', 'a path with no row is a caller bug, not "missing"');
  });

  test('putMutable verifies by value, so jsonb key reordering is not a mismatch', async () => {
    reset();
    const w = await setup();
    await store.putMutable(w.state, 'home.json', { schema: 1, shows: { b: 1, a: 2 }, generation: 3 });
    assert.notEqual(JSON.stringify(fake.state.rows.get('home')), JSON.stringify({ schema: 1, shows: { b: 1, a: 2 }, generation: 3 }));
    assert.equal(store.canonical({ a: 1, b: [1, { d: 1, c: 2 }] }), store.canonical({ b: [1, { c: 2, d: 1 }], a: 1 }));
    assert.notEqual(store.canonical([1, 2]), store.canonical([2, 1]));
  });

  test('setKill increments seq, records reason; unkill refuses to write blind', async () => {
    reset();
    const w = await setup();
    const k = await store.setKill(w.state, { killed: true, reason: 'bad publish', by: 'test' });
    assert.equal(k.seq, 2);
    assert.equal(k.killed, true);
    const u = await store.setKill(w.state, { killed: false, reason: 'fixed' });
    assert.equal(u.seq, 3);
    fake.state.failNext = 1;
    await assert.rejects(store.setKill(w.state, { killed: false }), /refusing a blind unkill/);
    assert.equal(fake.state.rows.get('kill').seq, 3);
  });

  test('a KILL still lands when the kill row is unreadable, with a seq above any earlier one', async () => {
    reset();
    const w = await setup();
    fake.state.failNext = 1; // the pre-read fails; the write and read-back work
    const now = 1_800_000_000_000;
    const k = await store.setKill(w.state, { killed: true, reason: 'emergency', now });
    assert.equal(k.seq, now);
    assert.equal(fake.state.rows.get('kill').killed, true);
    assert.equal(fake.state.rows.get('kill').seq, now);
  });

  test('setKill fails loudly when a concurrent writer changes kill after our write', async () => {
    reset();
    const w = await setup();
    let gets = 0;
    // The third GET (after the pre-read and putMutable's read-back) sees a rival write.
    const s = { ...w.state, get: async (path) => {
      gets++;
      if (gets === 3) fake.state.rows.set('kill', { schema: 1, killed: false, seq: 99 });
      return w.state.get(path);
    } };
    await assert.rejects(store.setKill(s, { killed: true, reason: 'x' }), /changed under us .*killed=false seq=99/);
  });

  test('effectiveKill fails closed on missing, error and malformed', () => {
    assert.equal(store.effectiveKill({ state: 'missing' }).killed, true);
    assert.equal(store.effectiveKill({ state: 'error', error: 'x' }).killed, true);
    assert.equal(store.effectiveKill({ state: 'ok', value: { killed: 'no' } }).killed, true);
    assert.equal(store.effectiveKill({ state: 'ok', value: null }).killed, true);
    assert.equal(store.effectiveKill({ state: 'ok', value: { killed: false } }).killed, false);
    assert.equal(store.effectiveKill({ state: 'ok', value: { killed: true, reason: 'r' } }).reason, 'r');
  });

  test('anon reads kill/home and show/ slices, nothing else, and cannot write', async () => {
    reset();
    const w = await setup();
    const r = reader();
    assert.equal((await store.readJsonObject(r.state, 'kill.json')).state, 'ok');
    assert.equal((await store.readJsonObject(r.state, 'home.json')).state, 'ok');
    const p = await store.putShowObject(w.storage, 'wicked-2003', 'aaaaaaaaaaaaaaaa', '{"v":1}');
    assert.equal(fake.state.headers.get(`show-refresh/${p}`), 'max-age=31536000, immutable');
    assert.equal((await r.storage.get(p)).text, '{"v":1}');
    fake.state.objects.set('show-refresh/covered.json', '{}');
    assert.notEqual((await r.storage.get('covered.json')).status, 200);
    await assert.rejects(r.state.put('kill.json', '{"killed":true}'), /401/);
    await assert.rejects(r.state.remove('kill.json'), /401/);
    await assert.rejects(r.storage.put(p, 'x'), /403|400/);
    const pub = makeStorage({ baseUrl: fake.baseUrl, bucket: 'show-refresh' });
    assert.notEqual((await pub.get(p)).status, 200, 'private bucket: no public endpoint');
  });

  test('getBucket: not-found is null, any other 400 throws', async () => {
    const mk = (status, body) => makeStorage({ baseUrl: 'http://x', serviceKey: 'k', bucket: 'b', isPublic: false,
      fetchImpl: async () => new Response(body, { status }) });
    assert.equal(await mk(400, '{"statusCode":"404","error":"Bucket not found"}').getBucket(), null);
    assert.equal(await mk(404, '').getBucket(), null);
    await assert.rejects(mk(400, '{"statusCode":"403","error":"Unauthorized"}').getBucket(), /getBucket 400/);
  });

  test('isObjectMissing: object not found is missing, bucket not found is not', () => {
    assert.equal(store.isObjectMissing({ status: 400, text: '{"statusCode":"404","error":"not_found","message":"Object not found"}' }), true);
    assert.equal(store.isObjectMissing({ status: 400, text: '{"statusCode":"404","error":"Bucket not found"}' }), false);
    assert.equal(store.isObjectMissing({ status: 404, text: '' }), true);
    assert.equal(store.isObjectMissing({ status: 400, text: '{"statusCode":"403"}' }), false);
  });
});

describe('show-refresh-store CLI', () => {
  const cli = require('../../scripts/show-refresh-store.js');
  const run = async (args, e = env()) => { const lines = []; const code = await cli.main(args, e, (l) => lines.push(l)); return { code, out: lines.join('\n') }; };

  test('usage errors exit 2', async () => {
    assert.equal((await run([])).code, 2);
    assert.equal((await run(['--kill'])).code, 2, 'kill needs a reason');
    assert.equal((await run(['--status', '--setup'])).code, 2);
    assert.equal((await run(['--reader-urls'])).code, 2, 'removed mode');
  });

  test('setup, kill, unkill, status round trip (the kill workflow\'s commands)', async () => {
    reset();
    assert.match((await run(['--status'])).out, /"bucket": "missing"/);
    assert.equal((await run(['--setup'])).code, 0);
    assert.match((await run(['--kill', '--reason=test kill'])).out, /killed=true seq=2/);
    const r = await run(['--status']);
    assert.equal(r.code, 0, r.out);
    const st = JSON.parse(r.out);
    assert.equal(st.public, false);
    assert.equal(st.kill.killed, true);
    assert.equal(st.kill.reason, 'test kill');
    assert.equal(st.home.generation, 0);
    assert.deepEqual(st.reader, { kill: 'ok', home: 'ok' });
    assert.match((await run(['--unkill', '--reason=ok'])).out, /killed=false seq=3/);
  });

  test('--status exits 1 on a malformed row, a missing bucket, or a reader that cannot see the rows', async () => {
    reset();
    assert.equal((await run(['--status'])).code, 1, 'bucket missing');
    await run(['--setup']);
    assert.equal((await run(['--status'])).code, 0);
    fake.state.rows.set('home', []);
    const r = await run(['--status']);
    assert.equal(r.code, 1);
    assert.match(r.out, /"state": "malformed"/);
    reset();
    await run(['--setup']);
    fake.state.rows.set('kill', { killed: 'yes' });
    assert.equal((await run(['--status'])).code, 1);
    reset();
    await run(['--setup']);
    assert.equal((await run(['--status'], { ...env(), NEXT_PUBLIC_SUPABASE_ANON_KEY: 'rotated' })).code, 1, 'reader view broken (rotated key / dropped policy)');
    fake.state.failNext = 1; // getBucket 500
    await assert.rejects(run(['--status']), /getBucket 500/);
  });

  test('the kill workflow passes every env var --status needs', async () => {
    const fs = require('node:fs');
    const yml = fs.readFileSync(new URL('../../.github/workflows/show-refresh-kill.yml', import.meta.url), 'utf8');
    const names = [...yml.matchAll(/^\s{10}([A-Z_]+): \$\{\{ secrets\.[A-Z_]+ \}\}/gm)].map((m) => m[1]);
    const real = env();
    const wfEnv = Object.fromEntries(names.filter((n) => n in real).map((n) => [n, real[n]]));
    reset();
    await run(['--setup'], wfEnv);
    const r = await run(['--status'], wfEnv);
    assert.equal(r.code, 0, `workflow env ${names.join(',')}: ${r.out}`);
  });

  test('a PostgREST 404 (table gone) is an error, not "missing"', async () => {
    const st = store.makeStateTable({ baseUrl: 'http://x', key: 'k', fetchImpl: async () => new Response('{"code":"PGRST205"}', { status: 404 }) });
    assert.equal((await store.readJsonObject(st, 'kill.json')).state, 'error');
  });

  test('selftest passes against a working store and cleans up its slice probe', async () => {
    reset();
    await run(['--setup']);
    const r = await run(['--selftest']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /selftest PASS: 3 state overwrite rounds/);
    assert.equal([...fake.state.objects.keys()].filter((k) => k.startsWith('show-refresh/show/_selftest/')).length, 0);
    assert.ok(fake.state.rows.has('probe'));
  });

  test('selftest FAILS when anon reads of the state are served stale (the Storage CDN bug)', async () => {
    reset();
    await run(['--setup']);
    fake.state.staleAnonRows = true;
    const r = await run(['--selftest']);
    assert.equal(r.code, 1);
    assert.match(r.out, /STALE/);
  });

  test('selftest FAILS when anon can read internal objects or write state', async () => {
    reset();
    const w = await setup();
    const leaky = { storage: { ...reader().storage, get: (p, o) => w.storage.get(p, o) }, state: w.state };
    const r = await cli.selftest(w, leaky);
    assert.equal(r.ok, false);
    assert.ok(r.failures.some((f) => /anon READ internal/.test(f)), r.failures.join('; '));
    assert.ok(r.failures.some((f) => /anon state write succeeded/.test(f)), r.failures.join('; '));
  });

  test('a multi-line reason is accepted', async () => {
    reset();
    await run(['--setup']);
    const r = await run(['--kill', '--reason=line one\nline two']);
    assert.equal(r.code, 0, r.out);
    assert.equal(fake.state.rows.get('kill').reason, 'line one\nline two');
  });
});
