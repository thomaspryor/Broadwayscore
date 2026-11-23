/**
 * BRO-8056 phase 1c: the private show-refresh store and the shared storage
 * client, run against a local fake of the Supabase Storage endpoints (private
 * bucket semantics: authenticated reads, signed URLs, 400/"404" for missing).
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

/** Fake Supabase Storage. opts.isPublic: bucket visibility when created. */
function startFake() {
  const state = { buckets: new Map(), objects: new Map(), headers: new Map(), failNext: 0, hangNext: 0, requests: [] };
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
      const p = url.pathname.replace(/^\/storage\/v1/, '');
      let m;
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
      if ((m = p.match(/^\/object\/sign\/([^/]+)\/(.+)$/)) && req.method === 'POST') {
        if (!authed) return done(401);
        const key = `${m[1]}/${m[2]}`;
        if (!state.objects.has(key)) return done(400, '{"statusCode":"404","error":"not_found"}');
        return done(200, JSON.stringify({ signedURL: `/object/sign/${m[1]}/${m[2]}?token=tok-${JSON.parse(body).expiresIn}` }));
      }
      if ((m = p.match(/^\/object\/sign\/([^/]+)\/(.+)$/)) && req.method === 'GET') {
        const key = `${m[1]}/${m[2]}`;
        if (!/^tok-\d+$/.test(url.searchParams.get('token') || '')) return done(400, '{"statusCode":"403"}');
        return state.objects.has(key) ? done(200, state.objects.get(key)) : done(400, '{"statusCode":"404"}');
      }
      if ((m = p.match(/^\/object\/authenticated\/([^/]+)\/(.+)$/)) && req.method === 'GET') {
        if (!authed) return done(400, '{"statusCode":"403"}');
        const key = `${m[1]}/${m[2]}`;
        return state.objects.has(key) ? done(200, state.objects.get(key)) : done(400, '{"statusCode":"404","error":"not_found","message":"Object not found"}');
      }
      if ((m = p.match(/^\/object\/public\/([^/]+)\/(.+)$/)) && req.method === 'GET') {
        const b = state.buckets.get(m[1]);
        const key = `${m[1]}/${m[2]}`;
        if (b && b.public === false) return done(400, '{"statusCode":"404"}');
        return state.objects.has(key) ? done(200, state.objects.get(key)) : done(400, '{"statusCode":"404"}');
      }
      if ((m = p.match(/^\/object\/([^/]+)\/(.+)$/))) {
        if (!authed) return done(401);
        const key = `${m[1]}/${m[2]}`;
        if (req.method === 'POST') { state.objects.set(key, body); state.headers.set(key, req.headers['cache-control']); return done(200, '{}'); }
        if (req.method === 'DELETE') { state.objects.delete(key); return done(200, '{}'); }
      }
      return done(400, '{"statusCode":"400"}');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ baseUrl: `http://127.0.0.1:${server.address().port}`, state, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) })));
}

let fake;
before(async () => { fake = await startFake(); });
after(async () => { await fake.close(); });
const env = () => ({ SUPABASE_URL: fake.baseUrl, SUPABASE_SERVICE_ROLE_KEY: KEY });
const reset = () => { fake.state.buckets.clear(); fake.state.objects.clear(); fake.state.headers.clear(); fake.state.failNext = 0; fake.state.hangNext = 0; };

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

  test('storeFromEnv needs URL and key, builds a private client', () => {
    assert.throws(() => store.storeFromEnv({}), /required/);
    assert.throws(() => store.storeFromEnv({ SUPABASE_URL: 'http://x' }), /required/);
    const s = store.storeFromEnv(env());
    assert.equal(s.bucket, 'show-refresh');
    assert.equal(s.isPublic, false);
  });

  test('setupStore creates a private bucket, seeds kill.json + home.json, and is idempotent', async () => {
    reset();
    const s = store.storeFromEnv(env());
    const first = await store.setupStore(s, { by: 'test' });
    assert.equal(first.bucket, 'created');
    assert.deepEqual(first.seeded.sort(), ['home.json', 'kill.json']);
    assert.equal(fake.state.buckets.get('show-refresh').public, false);
    assert.equal(fake.state.headers.get('show-refresh/kill.json'), 'no-cache');
    assert.equal(fake.state.headers.get('show-refresh/home.json'), 'no-cache');
    const kill = JSON.parse(fake.state.objects.get('show-refresh/kill.json'));
    assert.equal(kill.killed, false);
    assert.equal(kill.seq, 1);
    assert.deepEqual(JSON.parse(fake.state.objects.get('show-refresh/home.json')), store.HOME_PLACEHOLDER);
    const again = await store.setupStore(s);
    assert.equal(again.bucket, 'exists');
    assert.deepEqual(again.seeded, []);
    assert.equal(JSON.parse(fake.state.objects.get('show-refresh/kill.json')).seq, 1, 'setup never rewrites an existing kill.json');
  });

  test('setupStore refuses a bucket that is public', async () => {
    reset();
    fake.state.buckets.set('show-refresh', { id: 'show-refresh', public: true });
    await assert.rejects(store.setupStore(store.storeFromEnv(env())), /public; it must be private/);
    assert.equal(fake.state.objects.size, 0);
  });

  test('private objects are not readable on the public endpoint', async () => {
    reset();
    const s = store.storeFromEnv(env());
    await store.setupStore(s);
    const pub = makeStorage({ baseUrl: fake.baseUrl, bucket: 'show-refresh' });
    const r = await pub.get('home.json');
    assert.notEqual(r.status, 200);
  });

  test('readJsonObject tells ok / missing / error apart', async () => {
    reset();
    const s = store.storeFromEnv(env());
    await store.setupStore(s);
    assert.equal((await store.readJsonObject(s, 'home.json')).state, 'ok');
    assert.equal((await store.readJsonObject(s, 'covered.json')).state, 'missing');
    fake.state.failNext = 1;
    assert.equal((await store.readJsonObject(s, 'home.json')).state, 'error');
    fake.state.objects.set('show-refresh/health.json', 'not json');
    assert.equal((await store.readJsonObject(s, 'health.json')).state, 'error');
    const down = store.storeFromEnv({ SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SERVICE_ROLE_KEY: KEY });
    assert.equal((await store.readJsonObject(down, 'home.json')).state, 'error');
  });

  test('setKill increments seq, records reason; unkill refuses to write blind', async () => {
    reset();
    const s = store.storeFromEnv(env());
    await store.setupStore(s);
    const k = await store.setKill(s, { killed: true, reason: 'bad publish', by: 'test' });
    assert.equal(k.seq, 2);
    assert.equal(k.killed, true);
    const u = await store.setKill(s, { killed: false, reason: 'fixed' });
    assert.equal(u.seq, 3);
    fake.state.failNext = 1;
    await assert.rejects(store.setKill(s, { killed: false }), /refusing a blind unkill/);
    assert.equal(JSON.parse(fake.state.objects.get('show-refresh/kill.json')).seq, 3);
  });

  test('a KILL still lands when kill.json is unreadable, with a seq above any earlier one', async () => {
    reset();
    const s = store.storeFromEnv(env());
    await store.setupStore(s);
    fake.state.failNext = 1; // the pre-read fails; the write and read-back work
    const now = 1_800_000_000_000;
    const k = await store.setKill(s, { killed: true, reason: 'emergency', now });
    assert.equal(k.killed, true);
    assert.equal(k.seq, now);
    const stored = JSON.parse(fake.state.objects.get('show-refresh/kill.json'));
    assert.equal(stored.killed, true);
    assert.equal(stored.seq, now);
  });

  test('setKill overwrites a kill.json that is not valid JSON', async () => {
    reset();
    const s = store.storeFromEnv(env());
    await store.setupStore(s);
    fake.state.objects.set('show-refresh/kill.json', '{not json');
    const u = await store.setKill(s, { killed: false, reason: 'repair' });
    assert.equal(u.seq, 1);
    assert.equal(JSON.parse(fake.state.objects.get('show-refresh/kill.json')).killed, false);
  });

  test('setKill fails loudly when a concurrent writer changes kill.json after our write', async () => {
    reset();
    const base = store.storeFromEnv(env());
    await store.setupStore(base);
    let gets = 0;
    // The third GET (after the pre-read and putVerified's read-back) sees a rival write.
    const s = { ...base, get: async (path, o) => {
      gets++;
      if (gets === 3) fake.state.objects.set('show-refresh/kill.json', JSON.stringify({ schema: 1, killed: false, seq: 99 }));
      return base.get(path, o);
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
  });

  test('--status reports a malformed home.json or kill.json and exits 1', async () => {
    const { main } = require('../../scripts/show-refresh-store.js');
    const run = async (args) => { const lines = []; const code = await main(args, env(), (l) => lines.push(l)); return { code, out: lines.join('\n') }; };
    reset();
    await run(['--setup']);
    fake.state.objects.set('show-refresh/home.json', '[]');
    const r = await run(['--status']);
    assert.equal(r.code, 1);
    assert.match(r.out, /"state": "malformed"/);
    reset();
    await run(['--setup']);
    fake.state.objects.set('show-refresh/kill.json', '{"killed":"yes"}');
    assert.equal((await run(['--status'])).code, 1);
  });

  test('selftest fails when an overwrite is not visible through the same signed URL', async () => {
    reset();
    const base = store.storeFromEnv(env());
    await store.setupStore(base);
    let first;
    const fetchImpl = async (url, o) => {
      const res = await fetch(url, o);
      const body = await res.text();
      if (first === undefined) first = body; // a stale cache would keep serving v1
      return new Response(first, { status: res.status });
    };
    const { selftest } = require('../../scripts/show-refresh-store.js');
    const r = await selftest(base, { fetchImpl });
    assert.equal(r.ok, false);
    assert.equal(r.overwriteSeen, false);
  });

  test('putShowObject writes immutable cache-control and reads back', async () => {
    reset();
    const s = store.storeFromEnv(env());
    await store.setupStore(s);
    const p = await store.putShowObject(s, 'wicked-2003', 'aaaaaaaaaaaaaaaa', '{"v":1}');
    assert.equal(fake.state.headers.get(`show-refresh/${p}`), 'max-age=31536000, immutable');
  });

  test('readerUrls are absolute signed URLs that read the object without a key', async () => {
    reset();
    const s = store.storeFromEnv(env());
    await store.setupStore(s);
    const urls = await store.readerUrls(s);
    for (const [name, u] of Object.entries(urls)) {
      assert.match(u, /^http:\/\/127\.0\.0\.1:\d+\/storage\/v1\/object\/sign\/show-refresh\/(home|kill)\.json\?token=/, name);
      assert.ok(u.includes(`tok-${store.READER_URL_SECONDS}`), 'long-lived');
      const r = await fetch(u); // no Authorization header
      assert.equal(r.status, 200);
      JSON.parse(await r.text());
    }
  });
});

describe('show-refresh-store CLI', () => {
  const cli = require('../../scripts/show-refresh-store.js');
  const run = async (args) => { const lines = []; const code = await cli.main(args, env(), (l) => lines.push(l)); return { code, out: lines.join('\n') }; };

  test('usage errors exit 2', async () => {
    assert.equal((await run([])).code, 2);
    assert.equal((await run(['--kill'])).code, 2, 'kill needs a reason');
    assert.equal((await run(['--status', '--setup'])).code, 2);
    assert.equal((await run(['--reader-urls'])).code, 2, 'needs --out');
  });

  test('setup, kill, unkill, status round trip', async () => {
    reset();
    assert.equal((await run(['--status'])).out.includes('"bucket": "missing"'), true);
    assert.equal((await run(['--setup'])).code, 0);
    assert.match((await run(['--kill', '--reason=test kill'])).out, /killed=true seq=2/);
    const st = JSON.parse((await run(['--status'])).out);
    assert.equal(st.public, false);
    assert.equal(st.kill.killed, true);
    assert.equal(st.kill.reason, 'test kill');
    assert.equal(st.home.generation, 0);
    assert.match((await run(['--unkill', '--reason=ok'])).out, /killed=false seq=3/);
  });

  test('selftest passes against a working store and writes no-cache', async () => {
    reset();
    await run(['--setup']);
    const r = await run(['--selftest']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /PASS/);
    assert.equal(fake.state.headers.get('show-refresh/selftest.json'), 'no-cache');
  });

  test('reader-urls writes a 600 file and never prints a URL', async () => {
    reset();
    await run(['--setup']);
    const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'srs-')), 'urls.env');
    const r = await run(['--reader-urls', `--out=${file}`]);
    assert.equal(r.code, 0);
    assert.doesNotMatch(r.out, /token=|https?:\/\//);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.match(fs.readFileSync(file, 'utf8'), /^SHOW_REFRESH_HOME_URL=http.*\nSHOW_REFRESH_KILL_URL=http/);
  });
});

describe('review fixes (second opinion 1c)', () => {
  const cli = require('../../scripts/show-refresh-store.js');
  const run = async (args, e = env()) => { const lines = []; const code = await cli.main(args, e, (l) => lines.push(l)); return { code, out: lines.join('\n') }; };

  test('a missing bucket is an error, never "missing" (kill must not fail open)', () => {
    assert.equal(store.isObjectMissing({ status: 400, text: '{"statusCode":"404","error":"Bucket not found"}' }), false);
    assert.equal(store.isObjectMissing({ status: 400, text: '{"statusCode":"404","error":"not_found","message":"Object not found"}' }), true);
    assert.equal(store.isObjectMissing({ status: 404, text: '' }), true);
    assert.equal(store.isObjectMissing({ status: 400, text: '{"statusCode":"403"}' }), false);
    assert.equal(store.effectiveKill({ state: 'error' }).killed, true);
  });

  test('--status exits 1 when the bucket is missing or the store is down', async () => {
    reset();
    assert.equal((await run(['--status'])).code, 1, 'bucket missing');
    await run(['--setup']);
    assert.equal((await run(['--status'])).code, 0);
    fake.state.failNext = 1; // getBucket 500: main throws, the entry point exits 1
    await assert.rejects(run(['--status']), /getBucket 500/);
    fake.state.failNext = 0;
    fake.state.objects.delete('show-refresh/home.json'); // bucket fine, home.json gone
    assert.equal((await run(['--status'])).code, 1);
    assert.equal((await run(['--status'], { SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SERVICE_ROLE_KEY: KEY }).catch(() => ({ code: 1 }))).code, 1);
  });

  test('a multi-line reason is accepted', async () => {
    reset();
    await run(['--setup']);
    const r = await run(['--kill', '--reason=line one\nline two']);
    assert.equal(r.code, 0, r.out);
    assert.equal(JSON.parse(fake.state.objects.get('show-refresh/kill.json')).reason, 'line one\nline two');
  });
});
