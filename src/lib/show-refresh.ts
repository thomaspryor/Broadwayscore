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
//
// Caching (BRO-8170 gap 1): a cache entry's revalidate becomes the ceiling of
// the ISR page that reads it, so a short pointer TTL (it was 60 s) re-rendered
// every show page, reviews.json and OG image each minute once the flag is on.
// Freshness comes from explicit invalidation: pointers carry
// SHOW_REFRESH_POINTER_TAG, which /api/show-refresh/revalidate drops on every
// call, and every read carries SHOW_REFRESH_TAG, which the kill switch drops.
// THE PUBLISHER MUST CALL THAT ROUTE after it moves home.json, or a publish
// stays invisible for up to POINTER_MAX_AGE_S.
// Pointers still expire after POINTER_MAX_AGE_S, the show routes' own ISR
// period: it costs no extra renders, and it bounds how long a missed or failed
// revalidate call (or a slow read finishing after an invalidation) can leave a
// kill or publish unseen. Slices are immutable, so they never expire.
// tests/unit/show-refresh-wiring.test.ts pins both.

// All store reads of one render share one deadline (gap 7). Errors are thrown
// inside the cached functions so they are never cached, then caught here and
// turned into 'base-error'.
import 'server-only';
import fs from 'fs';
import path from 'path';
import { unstable_cache } from 'next/cache';
import {
  decideShowRefresh, showRefreshEnabled, SHOW_REFRESH_TAG, SHOW_REFRESH_POINTER_TAG,
  type RefreshDecision, type RefreshManifest, type StoreRead,
} from './show-refresh-core';

export { showRefreshEnabled, SHOW_REFRESH_TAG, SHOW_REFRESH_POINTER_TAG };

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

/** Network budget (plan 1.3): per client request, and for all reads of one render together. */
export const READ_TIMEOUT_MS = 2500;
export const READ_DEADLINE_MS = 2500;

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

/** Slugs this deployment could render from a slice: prerendered and not held at build. Null without a manifest. */
export function refreshableSlugs(): string[] | null {
  const m = buildManifest();
  if (!m) return null;
  return Object.values(m.shows).filter(s => s && typeof s.slug === 'string' && !s.held).map(s => s.slug);
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

/** = the show routes' `revalidate` (page, reviews.json, OG image). */
export const POINTER_MAX_AGE_S = 86400;

const cachedPointer = unstable_cache(
  (p: string) => cacheable(() => store.readJsonObject(stateClient(), p)),
  ['show-refresh-pointer'],
  // Never shorter than the routes' ISR period: see the header (gap 1).
  { revalidate: POINTER_MAX_AGE_S, tags: [SHOW_REFRESH_TAG, SHOW_REFRESH_POINTER_TAG] },
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
    deadlineMs: READ_DEADLINE_MS,
  });
}
