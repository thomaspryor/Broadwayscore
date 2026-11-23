// BRO-8056 phase 2: show-refresh reader, server side. Wires the decision in
// show-refresh-core.ts to the real store:
//   - kill / home pointers: Postgres table show_refresh_state through PostgREST
//     (anon key, never CDN-cached; Storage served stale bytes after overwrites),
//   - slices: immutable Storage objects show/<id>/<hash>.json (anon key),
//   - the build manifest: data/show-refresh-manifest.json (traced into ISR
//     functions by next.config.js outputFileTracingIncludes).
//
// Off unless SHOW_REFRESH_READER=on. During `next build` it never fetches
// (spike S0: builds make zero store requests) and returns the build's data.
// Pointers are cached 60 s and slices forever, all under tag 'show-refresh',
// so the kill route's revalidateTag('show-refresh') drops every cached read.
// Errors are thrown inside the cached functions so they are never cached,
// then caught here and turned into 'base-error'.
import 'server-only';
import fs from 'fs';
import path from 'path';
import { unstable_cache } from 'next/cache';
import {
  decideShowRefresh, showRefreshEnabled, SHOW_REFRESH_TAG, type RefreshDecision, type RefreshManifest, type StoreRead,
} from './show-refresh-core';

export { showRefreshEnabled, SHOW_REFRESH_TAG };

/* eslint-disable @typescript-eslint/no-require-imports */
const store = require('../../scripts/lib/show-refresh/store') as {
  PATHS: { home: string; kill: string };
  showObjectPath(id: string, hash: string): string;
  readerStoreFromEnv(env?: NodeJS.ProcessEnv, o?: { timeoutMs?: number }): unknown;
  readerStateFromEnv(env?: NodeJS.ProcessEnv, o?: { timeoutMs?: number }): unknown;
  readJsonObject(client: unknown, p: string, o?: { cacheBust?: number }): Promise<StoreRead>;
};
const { sliceHash } = require('../../scripts/lib/show-refresh/slice') as { sliceHash(s: unknown): string };
/* eslint-enable @typescript-eslint/no-require-imports */

/** Per-read network budget (plan 1.3). */
const READ_TIMEOUT_MS = 2500;
const POINTER_TTL_S = 60;

let manifestMemo: { value: RefreshManifest | null } | null = null;
/** The manifest this deployment was built with, or null (missing / unreadable / wrong shape). */
export function buildManifest(): RefreshManifest | null {
  if (manifestMemo) return manifestMemo.value;
  let value: RefreshManifest | null = null;
  try {
    // Literal path: Next's tracer must not see a data/ directory argument (src-no-traced-data-dir).
    const m = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'show-refresh-manifest.json'), 'utf8'));
    if (m && typeof m.manifestId === 'string' && m.shows && typeof m.shows === 'object' && Number.isFinite(m.buildInstant)) value = m;
  } catch {
    value = null;
  }
  manifestMemo = { value };
  return value;
}

/** A read that the cache may keep: 'ok' and 'missing'. 'error' throws so it is not cached. */
async function cacheable(read: () => Promise<StoreRead>): Promise<StoreRead> {
  const r = await read();
  if (r.state === 'error') throw new Error(r.error);
  return r;
}

const asError = (e: unknown): StoreRead => ({ state: 'error', error: e instanceof Error ? e.message : String(e) });

function stateClient() { return store.readerStateFromEnv(process.env, { timeoutMs: READ_TIMEOUT_MS }); }
function sliceClient() { return store.readerStoreFromEnv(process.env, { timeoutMs: READ_TIMEOUT_MS }); }

const cachedPointer = unstable_cache(
  (p: string) => cacheable(() => store.readJsonObject(stateClient(), p)),
  ['show-refresh-pointer'],
  { revalidate: POINTER_TTL_S, tags: [SHOW_REFRESH_TAG] },
);
const cachedSlice = unstable_cache(
  // A missing slice throws too: slices are immutable once present, so caching
  // 'missing' forever would pin a page to base-error after one early read.
  async (id: string, hash: string) => {
    const r = await cacheable(() => store.readJsonObject(sliceClient(), store.showObjectPath(id, hash)));
    if (r.state === 'missing') throw new Error('slice missing');
    return r;
  },
  ['show-refresh-slice'],
  { revalidate: false, tags: [SHOW_REFRESH_TAG] },
);

async function safe(read: () => Promise<StoreRead>): Promise<StoreRead> {
  try { return await read(); } catch (e) { return asError(e); }
}

/** Which data this render of /show/<slug> uses. Never throws. */
export function readShowRefresh(slug: string): Promise<RefreshDecision> {
  return decideShowRefresh(slug, {
    enabled: showRefreshEnabled(),
    manifest: showRefreshEnabled() ? buildManifest() : null,
    readKill: () => safe(() => cachedPointer(store.PATHS.kill)),
    readHome: () => safe(() => cachedPointer(store.PATHS.home)),
    readSlice: (id, hash) => safe(() => cachedSlice(id, hash)),
    sliceHash,
  });
}
