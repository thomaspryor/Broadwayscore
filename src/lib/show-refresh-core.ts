// BRO-8056 phase 2: the show-refresh reader's decision, with every input
// injected (no Next, no fetch, no fs), so tests drive it with fake reads.
// src/lib/show-refresh.ts wires the real store, manifest and cache.
//
// The one rule: any doubt => the build's data. A store error never throws and
// never 5xx's a page; it renders the build with marker 'base-error' (plan R7),
// which the publisher's verify treats as "not applied yet" and re-queues.

/** Render used the build's data on purpose (flag off, killed, not listed, held, unchanged). */
export const REV_BASE = 'base';
/** Render fell back to the build because the store or the slice could not be trusted. */
export const REV_BASE_ERROR = 'base-error';

/** Cache tag on every store read; revalidateTag(SHOW_REFRESH_TAG) drops them all. */
export const SHOW_REFRESH_TAG = 'show-refresh';
/** Cache tag on the kill / home pointer reads only; every revalidate call drops it. */
export const SHOW_REFRESH_POINTER_TAG = 'show-refresh-pointer';

/** Page marker: `<meta name="show-refresh-rev" content="<rev>">` (plan row 10). */
export const SHOW_REFRESH_REV_META = 'show-refresh-rev';
/** reviews.json marker header, same value as the page marker. */
export const SHOW_REFRESH_REV_HEADER = 'x-show-refresh-hash';

/** True when a render used a published slice (its rev is a slice hash), not the build's data. */
export function isRefreshedRev(rev: string | null | undefined): boolean {
  return typeof rev === 'string' && /^[0-9a-f]{16}$/.test(rev);
}

/**
 * The reader's on switch: SHOW_REFRESH_READER=on, and never during `next build`
 * (spike S0: builds make zero store requests and render the build's data).
 */
export function showRefreshEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NEXT_PHASE === 'phase-production-build') return false;
  return env.SHOW_REFRESH_READER === 'on';
}

/**
 * The flag as set for this deployment, build phase included. A page prerendered
 * by a flag-on build renders the build's data ('base') but must still tell the
 * browser so, or reviews.json regenerated from a slice would be accepted
 * unchecked (BRO-8170 gap 3). Flag off: false, so nothing changes.
 */
export function showRefreshConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SHOW_REFRESH_READER === 'on';
}

/** Result of one store read, as scripts/lib/show-refresh/store.js readJsonObject returns it. */
export type StoreRead =
  | { state: 'ok'; value: unknown }
  | { state: 'missing' }
  | { state: 'error'; error: string };

export interface ManifestShow { slug: string; hash: string; held: boolean; imagesSig: string }
export interface RefreshManifest {
  schema: number;
  sliceVersion: number;
  manifestId: string;
  buildInstant: number;
  shows: Record<string, ManifestShow>;
}

/** A published slice (scripts/lib/show-refresh/slice.js sliceFor). Only the fields the reader checks are typed. */
export interface PublishedSlice {
  sliceVersion: number;
  showId: string;
  row: { id: string; slug: string; [k: string]: unknown };
  reviews: unknown[];
  blogReviews: unknown[];
  audience: unknown[];
  buzz: unknown[];
  consensus: unknown;
  audienceBuzz: unknown;
  coverage: { cov: unknown; scorePublicSince: unknown; acked: boolean };
}

export interface RefreshDeps {
  enabled: boolean;
  manifest: RefreshManifest | null;
  readKill(): Promise<StoreRead>;
  readHome(): Promise<StoreRead>;
  readSlice(id: string, hash: string): Promise<StoreRead>;
  /** 16-hex content hash of a slice (slice.js sliceHash). */
  sliceHash(slice: unknown): string;
  /**
   * One budget, in ms, for ALL store reads of this decision (kill, home, slice
   * together), counted from the call. A read still pending when it runs out
   * becomes an error, so the render falls back to the build ('base-error').
   * Unset = no shared deadline (each read keeps only its own client timeout).
   */
  deadlineMs?: number;
  /** Clock for deadlineMs (tests). Default Date.now. */
  now?(): number;
}

export const READ_DEADLINE_ERROR = 'store read deadline exceeded';

/**
 * `read()` raced against an absolute deadline. Never rejects: a throw or the
 * deadline both resolve to a StoreRead error, and the timer is always cleared.
 */
export async function readWithDeadline(
  read: () => Promise<StoreRead>, deadline: number | null, now: () => number = Date.now,
): Promise<StoreRead> {
  const asErr = (e: unknown): StoreRead => ({ state: 'error', error: e instanceof Error ? e.message : String(e) });
  if (deadline == null) {
    try { return await read(); } catch (e) { return asErr(e); }
  }
  const remaining = deadline - now();
  if (!(remaining > 0)) return { state: 'error', error: READ_DEADLINE_ERROR };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<StoreRead>(resolve => {
    timer = setTimeout(() => resolve({ state: 'error', error: READ_DEADLINE_ERROR }), remaining);
  });
  try {
    return await Promise.race([read().catch(asErr), expired]);
  } finally {
    clearTimeout(timer);
  }
}

export type RefreshDecision =
  | { rev: typeof REV_BASE | typeof REV_BASE_ERROR; reason: string; showId: string | null }
  | { rev: string; reason: 'published'; showId: string; slice: PublishedSlice };

const base = (reason: string, showId: string | null = null): RefreshDecision => ({ rev: REV_BASE, reason, showId });
const baseError = (reason: string, showId: string | null = null): RefreshDecision => ({ rev: REV_BASE_ERROR, reason, showId });

/** slug -> id over the manifest's prerendered shows (built once per manifest). */
const slugIndex = new WeakMap<RefreshManifest, Map<string, string>>();
export function manifestIdForSlug(manifest: RefreshManifest, slug: string): string | null {
  let m = slugIndex.get(manifest);
  if (!m) {
    m = new Map();
    for (const [id, s] of Object.entries(manifest.shows)) if (isRecord(s) && typeof s.slug === 'string') m.set(s.slug, id);
    slugIndex.set(manifest, m);
  }
  return m.get(slug) ?? null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A kill state the reader can act on; anything but a valid row reads as killed (store.js effectiveKill). */
function killedBy(read: StoreRead): { killed: boolean; error: boolean } {
  if (read.state !== 'ok' || !isRecord(read.value) || typeof read.value.killed !== 'boolean') {
    return { killed: true, error: read.state !== 'missing' };
  }
  return { killed: read.value.killed, error: false };
}

/**
 * Which data one render of /show/<slug> uses. Never throws: a dependency that
 * throws is caught and becomes 'base-error'.
 */
export async function decideShowRefresh(slug: string, deps: RefreshDeps): Promise<RefreshDecision> {
  if (!deps.enabled) return base('flag off');
  const manifest = deps.manifest;
  if (!manifest || !isRecord(manifest.shows) || typeof manifest.manifestId !== 'string') return base('no usable build manifest');
  let id: string | null = null;
  const now = deps.now ?? Date.now;
  const deadline = Number.isFinite(deps.deadlineMs) ? now() + (deps.deadlineMs as number) : null;
  const timed = (read: () => Promise<StoreRead>) => readWithDeadline(read, deadline, now);
  try {
    id = manifestIdForSlug(manifest, slug);
    if (!id) return base('not prerendered by this build');
    const built = manifest.shows[id];
    if (!isRecord(built) || typeof built.hash !== 'string') return baseError('build manifest entry malformed', id);
    if (built.held) return base('held at build', id);
    const kill = killedBy(await timed(() => deps.readKill()));
    if (kill.killed) return kill.error ? baseError('kill state unreadable', id) : base('killed', id);

    const home = await timed(() => deps.readHome());
    if (home.state === 'error') return baseError(`home unreadable: ${home.error}`, id);
    if (home.state === 'missing') return base('no published index', id);
    if (!isRecord(home.value) || typeof home.value.manifestId !== 'string') return baseError('published index malformed', id);
    if (home.value.manifestId !== manifest.manifestId) return base('index belongs to another build', id);
    const shows = home.value.shows;
    if (!isRecord(shows)) return baseError('published index malformed', id);
    const entry = shows[id];
    if (entry === undefined) return base('not in published index', id);
    if (!isRecord(entry) || typeof entry.hash !== 'string') return baseError('published index entry malformed', id);
    if (entry.hash === built.hash) return base('published hash equals build', id);
    if (!/^[0-9a-f]{16}$/.test(entry.hash)) return baseError('published hash malformed', id);

    const obj = await timed(() => deps.readSlice(id as string, entry.hash as string));
    if (obj.state !== 'ok') return baseError(`slice ${obj.state === 'error' ? `unreadable: ${obj.error}` : 'missing'}`, id);
    const slice = obj.value;
    if (!isRecord(slice) || !isRecord(slice.row) || !isRecord(slice.coverage)) return baseError('slice malformed', id);
    if (slice.sliceVersion !== manifest.sliceVersion) return base('slice version differs from build', id);
    if (slice.showId !== id || slice.row.id !== id) return baseError('slice is for another show', id);
    if (slice.row.slug !== slug) return baseError('slice slug differs', id);
    if (deps.sliceHash(slice) !== entry.hash) return baseError('slice hash mismatch', id);
    return { rev: entry.hash, reason: 'published', showId: id, slice: slice as unknown as PublishedSlice };
  } catch (e) {
    return baseError(`reader error: ${e instanceof Error ? e.message : String(e)}`, id);
  }
}
