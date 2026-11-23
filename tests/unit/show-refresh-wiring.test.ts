/**
 * BRO-8170: src/lib/show-refresh.ts store wiring, with the store, next/cache and
 * server-only stubbed (gap 8), so no network and no Next runtime.
 *  - gap 1: no cached store read may carry a time-based revalidate shorter than
 *    the ISR routes that read it (page, reviews.json, OG image). A 60 s pointer
 *    TTL re-rendered every show page each minute once the flag is on.
 *  - gap 7: kill, home and slice reads share ONE deadline; a store that never
 *    answers still yields a render ('base-error') within that budget.
 *  - wiring: which client and path each read uses, what is cached, what is not.
 *
 * Run: npx tsx --test tests/unit/show-refresh-wiring.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import Module from 'module';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const { sliceHash, SLICE_VERSION } = require('../../scripts/lib/show-refresh/slice');
const realStore = require('../../scripts/lib/show-refresh/store');

type Read = { state: 'ok'; value: unknown } | { state: 'missing' } | { state: 'error'; error: string };
interface CacheCall { keyParts: string[]; opts: { revalidate?: number | false; tags?: string[] } }

// ---- stubs ------------------------------------------------------------------
const cacheCalls: CacheCall[] = [];
const cacheStore = new Map<string, unknown>();
/** unstable_cache stand-in: caches resolved values by key + args, never a rejection. */
function fakeUnstableCache(fn: (...a: any[]) => Promise<unknown>, keyParts: string[], opts: CacheCall['opts']) {
  cacheCalls.push({ keyParts, opts });
  return async (...args: any[]) => {
    const k = JSON.stringify([keyParts, args]);
    if (cacheStore.has(k)) return cacheStore.get(k);
    const v = await fn(...args);
    cacheStore.set(k, v);
    return v;
  };
}

let reads: Array<{ client: string; path: string }> = [];
let answer: (client: string, p: string) => Promise<Read> = async () => ({ state: 'missing' });
const stubStore = {
  PATHS: realStore.PATHS,
  showObjectPath: realStore.showObjectPath,
  readerStateFromEnv: () => ({ kind: 'state' }),
  readerStoreFromEnv: () => ({ kind: 'storage' }),
  readJsonObject: (client: { kind: string }, p: string) => { reads.push({ client: client.kind, path: p }); return answer(client.kind, p); },
};

const origLoad = (Module as any)._load;
(Module as any)._load = function (request: string, ...rest: unknown[]) {
  if (request === 'server-only') return {};
  if (request === 'next/cache') return { unstable_cache: fakeUnstableCache };
  if (/scripts\/lib\/show-refresh\/store$/.test(request)) return stubStore;
  return origLoad.call(this, request, ...rest);
};
test.after(() => { (Module as any)._load = origLoad; });

const reader = require('../../src/lib/show-refresh') as typeof import('../../src/lib/show-refresh');
const core = require('../../src/lib/show-refresh-core') as typeof import('../../src/lib/show-refresh-core');
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

// ---- a manifest the reader will find ---------------------------------------
const slice = {
  sliceVersion: SLICE_VERSION, showId: 'hamilton-2015', row: { id: 'hamilton-2015', slug: 'hamilton' },
  reviews: [], blogReviews: [], audience: [], buzz: [], consensus: null, audienceBuzz: null,
  coverage: { cov: null, scorePublicSince: null, acked: false },
};
const HASH = sliceHash(slice);
const manifest = {
  schema: 1, sliceVersion: SLICE_VERSION, manifestId: 'm1', buildInstant: Date.UTC(2026, 10, 23),
  shows: {
    'hamilton-2015': { slug: 'hamilton', hash: '0000000000000000', held: false, imagesSig: 'x' },
    'held-2020': { slug: 'held-show', hash: '1111111111111111', held: true, imagesSig: 'x' },
  },
};

function withFlag<T>(fn: () => Promise<T>): Promise<T> {
  const prev = { r: process.env.SHOW_REFRESH_READER, p: process.env.NEXT_PHASE };
  process.env.SHOW_REFRESH_READER = 'on';
  delete process.env.NEXT_PHASE;
  return fn().finally(() => {
    if (prev.r === undefined) delete process.env.SHOW_REFRESH_READER; else process.env.SHOW_REFRESH_READER = prev.r;
    if (prev.p !== undefined) process.env.NEXT_PHASE = prev.p;
  });
}

const goodStore = async (_c: string, p: string): Promise<Read> => {
  if (p === realStore.PATHS.kill) return { state: 'ok', value: { schema: 1, killed: false, seq: 1 } };
  if (p === realStore.PATHS.home) return { state: 'ok', value: { manifestId: 'm1', shows: { 'hamilton-2015': { hash: HASH } } } };
  if (p === realStore.showObjectPath('hamilton-2015', HASH)) return { state: 'ok', value: slice };
  return { state: 'missing' };
};

// The reader memoizes the manifest from cwd/data; point it at a temp copy.
const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'srw-'));
fs.mkdirSync(path.join(tmp, 'data'));
fs.writeFileSync(path.join(tmp, 'data', 'show-refresh-manifest.json'), JSON.stringify(manifest));
const cwd = process.cwd();
const repo = path.join(__dirname, '../..');
process.chdir(tmp);
const loaded = reader.buildManifest();
process.chdir(cwd);
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function reset() { reads = []; cacheStore.clear(); }

// ---- gap 1 -----------------------------------------------------------------
function routeRevalidate(rel: string): number {
  const src = fs.readFileSync(path.join(repo, rel), 'utf8');
  const m = src.match(/export const revalidate\s*=\s*(\d+)/);
  assert.ok(m, `${rel} declares a numeric revalidate`);
  return Number(m[1]);
}

test('gap 1: no cached store read expires sooner than the ISR routes that read it', () => {
  assert.ok(cacheCalls.length >= 2, 'show-refresh.ts builds its unstable_cache functions at load');
  const floor = Math.max(...['src/app/show/[slug]/page.tsx', 'src/app/show/[slug]/reviews.json/route.ts', 'src/app/show/[slug]/opengraph-image.tsx'].map(routeRevalidate));
  for (const c of cacheCalls) {
    const r = c.opts.revalidate;
    assert.ok(r === false || (typeof r === 'number' && r >= floor),
      `${c.keyParts.join('/')} revalidate=${String(r)} would cap the page's ISR (${floor}s)`);
    assert.ok(c.opts.tags?.includes(core.SHOW_REFRESH_TAG), `${c.keyParts.join('/')} carries the kill tag`);
  }
  const pointer = cacheCalls.find(c => c.keyParts.includes('show-refresh-pointer'));
  assert.ok(pointer?.opts.tags?.includes(core.SHOW_REFRESH_POINTER_TAG), 'pointer reads carry the pointer tag the revalidate route drops');
});

// ---- gap 8: wiring -----------------------------------------------------------
test('manifest loads from data/; refreshableSlugs lists the non-held shows only', () => {
  assert.equal(loaded?.manifestId, 'm1');
  assert.deepEqual(reader.refreshableSlugs(), ['hamilton']);
});

test('wiring: kill and home from the state table, the slice from Storage, then the published hash', async () => {
  reset(); answer = goodStore;
  const d = await withFlag(() => reader.readShowRefresh('hamilton'));
  assert.equal(d.rev, HASH, d.reason);
  assert.deepEqual(reads, [
    { client: 'state', path: realStore.PATHS.kill },
    { client: 'state', path: realStore.PATHS.home },
    { client: 'storage', path: realStore.showObjectPath('hamilton-2015', HASH) },
  ]);
  // Cached: a second render makes no store reads.
  reads = [];
  assert.equal((await withFlag(() => reader.readShowRefresh('hamilton'))).rev, HASH);
  assert.deepEqual(reads, []);
});

test('wiring: an error read is never cached (the next render reads again) and renders base-error', async () => {
  reset();
  answer = async (c, p) => (p === realStore.PATHS.kill ? { state: 'error', error: 'HTTP 503' } : goodStore(c, p));
  const d = await withFlag(() => reader.readShowRefresh('hamilton'));
  assert.equal(d.rev, core.REV_BASE_ERROR);
  answer = goodStore; reads = [];
  assert.equal((await withFlag(() => reader.readShowRefresh('hamilton'))).rev, HASH);
  assert.equal(reads[0].path, realStore.PATHS.kill, 'kill read again after the error');
});

test('wiring: a missing slice is not cached (it may appear a moment later)', async () => {
  reset();
  answer = async (c, p) => (p.startsWith('show/') ? { state: 'missing' } : goodStore(c, p));
  assert.equal((await withFlag(() => reader.readShowRefresh('hamilton'))).rev, core.REV_BASE_ERROR);
  answer = goodStore;
  assert.equal((await withFlag(() => reader.readShowRefresh('hamilton'))).rev, HASH);
});

test('wiring: flag off reads nothing; a held or unknown show reads nothing', async () => {
  reset(); answer = goodStore;
  delete process.env.SHOW_REFRESH_READER;
  assert.equal((await reader.readShowRefresh('hamilton')).rev, core.REV_BASE);
  assert.equal((await withFlag(() => reader.readShowRefresh('held-show'))).rev, core.REV_BASE);
  assert.equal((await withFlag(() => reader.readShowRefresh('no-such-show'))).rev, core.REV_BASE);
  assert.deepEqual(reads, []);
});

// ---- gap 7 -----------------------------------------------------------------
test('gap 7: one deadline for all three reads; a store that never answers still renders in budget', { timeout: 10_000 }, async () => {
  reset();
  answer = () => new Promise<Read>(() => { /* never settles */ });
  const t0 = Date.now();
  const d = await withFlag(() => reader.readShowRefresh('hamilton'));
  const took = Date.now() - t0;
  assert.equal(d.rev, core.REV_BASE_ERROR);
  assert.ok(took <= reader.READ_DEADLINE_MS + 500, `rendered in ${took} ms`);
});

test('gap 7: reads that are each under budget but together over it fall back', { timeout: 10_000 }, async () => {
  reset();
  // Each read alone is within the per-read client timeout; three in a row are not within the shared deadline.
  const each = Math.ceil(reader.READ_DEADLINE_MS / 2);
  answer = (c, p) => new Promise<Read>(r => setTimeout(() => goodStore(c, p).then(r), each));
  const t0 = Date.now();
  const d = await withFlag(() => reader.readShowRefresh('hamilton'));
  assert.equal(d.rev, core.REV_BASE_ERROR, d.reason);
  assert.match(d.reason, /deadline/);
  assert.ok(Date.now() - t0 <= reader.READ_DEADLINE_MS + 500);
});
