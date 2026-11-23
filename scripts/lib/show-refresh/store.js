'use strict';
/**
 * BRO-8056: the show-refresh store (plan v14-final §1.2).
 *
 * Two homes, chosen by how each object changes:
 *   - Storage bucket `show-refresh` (private): immutable slices
 *     show/<id>/<hash>.json (1-year cache), plus covered.json, health.json and
 *     flagged/<sha>.json (later phases; service role only).
 *   - Table public.show_refresh_state, read through PostgREST: the MUTABLE
 *     pointers home (index the reader follows) and kill (kill switch), plus a
 *     'probe' row for --selftest.
 *
 * Why the split (measured 2026-11-23): Supabase's Storage CDN served the OLD
 * bytes of an overwritten object to shared-credential readers, both through a
 * signed URL and to the anon key on the authenticated endpoint (cf HIT despite
 * "private, no-cache"). Only per-service-key reads came back fresh. A slice's
 * path changes with its content, so a cached slice is always right; a pointer
 * is not. PostgREST answers are not CDN-cached (cf-cache-status DYNAMIC).
 *
 * Writes need the service-role key and happen only in CI (single writer, R4).
 * The site reader holds only the PUBLIC anon key. RLS
 * (supabase/migrations/20261123b_show_refresh_state.sql) lets anon SELECT the
 * state rows and Storage objects under show/ (already-public page data; held
 * shows are never published) and nothing else. Anon can also LIST show/, so
 * the writer must never upload a slice for a held or unrevealed show. Writers
 * share the show-refresh-kill concurrency group: setKill is read-modify-write. `show-refresh-store.js
 * --selftest` proves freshness and the denials on the real store, and must pass
 * before any reader is switched on.
 *
 * Both clients expose get(path) -> { status, text }, so every read goes through
 * readJsonObject and returns { state: 'ok' | 'missing' | 'error' }: a caller
 * can tell "not there" from "store down" (an error is never "unkilled").
 */
const { makeStorage, putVerified } = require('../live-score/storage');

const BUCKET = 'show-refresh';
const CACHE = Object.freeze({
  immutable: 'max-age=31536000, immutable',
  mutable: 'no-cache',
});
const PATHS = Object.freeze({
  home: 'home.json',
  kill: 'kill.json',
  covered: 'covered.json',
  health: 'health.json',
  probe: 'probe.json',
});
const ID_RE = /^[a-z0-9][a-z0-9-]{0,120}$/;
const HASH_RE = /^[0-9a-f]{16}$/;
const HOME_PLACEHOLDER = Object.freeze({ schema: 1, manifestId: null, coreSha: null, generation: 0, shows: {}, pending: {} });

function showObjectPath(id, hash) {
  if (!ID_RE.test(String(id))) throw new Error(`show-refresh: bad show id ${JSON.stringify(id)}`);
  if (!HASH_RE.test(String(hash))) throw new Error(`show-refresh: bad slice hash ${JSON.stringify(hash)}`);
  return `show/${id}/${hash}.json`;
}

/**
 * Storage objects the anon reader may read; mirrors the storage RLS policy
 * (first folder = 'show'). A unit test pins the two together.
 */
function isReaderPath(path) {
  return /^show\/[^/]/.test(String(path));
}

const STATE_TABLE = 'show_refresh_state';
/** State-table paths -> row keys (the table's CHECK allows exactly these). */
const STATE_KEYS = Object.freeze({ [PATHS.home]: 'home', [PATHS.kill]: 'kill', [PATHS.probe]: 'probe' });

/**
 * Client for public.show_refresh_state over PostgREST, shaped like the
 * Storage client: get(path) -> { status, text } (an absent row is status 404),
 * put(path, text), remove(path). path is one of STATE_KEYS.
 */
function makeStateTable({ baseUrl, key, timeoutMs, fetchImpl = fetch }) {
  const root = `${String(baseUrl).replace(/\/$/, '')}/rest/v1/${STATE_TABLE}`;
  const auth = { apikey: key, Authorization: `Bearer ${key}` };
  const call = (url, init = {}) => fetchImpl(url, timeoutMs ? { ...init, signal: AbortSignal.timeout(timeoutMs) } : init);
  const rowKey = (path) => {
    const k = STATE_KEYS[path];
    if (!k) throw new Error(`show-refresh state: no row for ${JSON.stringify(path)}`);
    return k;
  };
  async function get(path) {
    const res = await call(`${root}?key=eq.${rowKey(path)}&select=value`, { headers: { ...auth, accept: 'application/json' } });
    const body = await res.text().catch(() => '');
    // Only an empty 200 means "no row". A PostgREST 404 (table missing, stale
    // schema cache) is a store error, never "missing".
    if (!res.ok) return { status: res.status === 404 ? 502 : res.status, text: body.slice(0, 500) };
    let rows;
    try { rows = JSON.parse(body); } catch { return { status: 502, text: 'state: invalid JSON from PostgREST' }; }
    if (!Array.isArray(rows)) return { status: 502, text: 'state: not an array' };
    if (rows.length === 0) return { status: 404, text: '' };
    return { status: 200, text: JSON.stringify(rows[0].value) };
  }
  async function put(path, text) {
    const res = await call(`${root}?on_conflict=key`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json', prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ key: rowKey(path), value: JSON.parse(text), updated_at: new Date().toISOString() }),
    });
    if (!res.ok) throw new Error(`state put ${path} ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  }
  async function remove(path) {
    // return=representation: RLS silently filters a forbidden DELETE to 0 rows,
    // so the caller needs the count to tell "deleted" from "not allowed".
    const res = await call(`${root}?key=eq.${rowKey(path)}`, { method: 'DELETE', headers: { ...auth, prefer: 'return=representation' } });
    const body = await res.text().catch(() => '');
    if (!res.ok) throw new Error(`state remove ${path} ${res.status}`);
    let n = 0;
    try { n = JSON.parse(body).length; } catch { /* empty body */ }
    return n;
  }
  return { get, put, remove, table: STATE_TABLE };
}

function envUrl(env) { return env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL; }
function requireEnv(env, keyName, who) {
  const baseUrl = envUrl(env);
  const key = env[keyName];
  if (!baseUrl || !key) throw new Error(`show-refresh ${who}: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and ${keyName} are required`);
  return { baseUrl, key };
}
const withFetch = (fetchImpl) => (fetchImpl ? { fetchImpl } : {});

/** Writer Storage client (service key). Throws when the URL or key is missing. */
function storeFromEnv(env = process.env, { timeoutMs = 10000, fetchImpl } = {}) {
  const { baseUrl, key } = requireEnv(env, 'SUPABASE_SERVICE_ROLE_KEY', 'store');
  return makeStorage({ baseUrl, serviceKey: key, bucket: env.SHOW_REFRESH_BUCKET || BUCKET, isPublic: false, timeoutMs, ...withFetch(fetchImpl) });
}
/** Reader Storage client (public anon key): show/ slices only. */
function readerStoreFromEnv(env = process.env, { timeoutMs = 2500, fetchImpl } = {}) {
  const { baseUrl, key } = requireEnv(env, 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'reader');
  return makeStorage({ baseUrl, serviceKey: key, bucket: env.SHOW_REFRESH_BUCKET || BUCKET, isPublic: false, timeoutMs, ...withFetch(fetchImpl) });
}
/** Writer state-table client (service key). */
function stateFromEnv(env = process.env, { timeoutMs = 10000, fetchImpl } = {}) {
  const { baseUrl, key } = requireEnv(env, 'SUPABASE_SERVICE_ROLE_KEY', 'state');
  return makeStateTable({ baseUrl, key, timeoutMs, ...withFetch(fetchImpl) });
}
/** Reader state-table client (public anon key). */
function readerStateFromEnv(env = process.env, { timeoutMs = 2500, fetchImpl } = {}) {
  const { baseUrl, key } = requireEnv(env, 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'reader state');
  return makeStateTable({ baseUrl, key, timeoutMs, ...withFetch(fetchImpl) });
}

/**
 * Supabase answers a missing OBJECT with 404, or 400 {"statusCode":"404",
 * "error":"not_found","message":"Object not found"}. A missing BUCKET
 * ("Bucket not found") is an error, not "missing": effectiveKill would read
 * missing kill.json as "not killed" and fail open.
 */
function isObjectMissing(r) {
  const t = r.text || '';
  if (/bucket not found/i.test(t)) return false;
  return r.status === 404 || (r.status === 400 && /"statusCode"\s*:\s*"404"/.test(t));
}

async function readJsonObject(storage, path, { cacheBust = Date.now() } = {}) {
  let r;
  try {
    r = await storage.get(path, { cacheBust });
  } catch (e) {
    return { state: 'error', error: String(e && e.message || e) };
  }
  if (isObjectMissing(r)) return { state: 'missing' };
  if (r.status !== 200) return { state: 'error', error: `status ${r.status}` };
  try {
    return { state: 'ok', value: JSON.parse(r.text) };
  } catch {
    return { state: 'error', error: 'invalid JSON' };
  }
}

/** Key-order-independent JSON (jsonb stores keys in its own order). */
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}

/**
 * Write a mutable JSON value (a state row, or a no-cache Storage object) and
 * read it back; throws unless the stored value equals the one written.
 */
async function putMutable(client, path, value) {
  const text = JSON.stringify(value);
  await client.put(path, text, { cacheControl: CACHE.mutable });
  const back = await readJsonObject(client, path);
  if (back.state !== 'ok' || canonical(back.value) !== canonical(value)) {
    throw new Error(`verify mismatch for ${path} (${back.state})`);
  }
  return text;
}

/** Write one immutable slice object and read it back. */
async function putShowObject(storage, id, hash, text) {
  const path = showObjectPath(id, hash);
  await putVerified(storage, path, text, { cacheControl: CACHE.immutable });
  return path;
}

/**
 * Kill state. Reads the current kill.json so seq always increases.
 * - Store unreadable (network / 5xx): refuse, unless the request is KILL. A
 *   kill must work when it is most needed, so it writes blind with
 *   seq = max(prev+1, now): still monotonic against any earlier write.
 * - kill.json invalid JSON / malformed: overwrite (there is nothing to keep).
 * After writing, re-read and confirm the stored state is the one requested
 * (a concurrent writer wins visibly, never silently).
 */
async function setKill(state, { killed, reason = '', by = '', now = Date.now() }) {
  const want = Boolean(killed);
  const cur = await readJsonObject(state, PATHS.kill);
  const unreadable = cur.state === 'error' && cur.error !== 'invalid JSON';
  if (unreadable && !want) throw new Error(`setKill: kill.json unreadable (${cur.error}); refusing a blind unkill`);
  const prevSeq = cur.state === 'ok' && cur.value && Number.isInteger(cur.value.seq) ? cur.value.seq : 0;
  const seq = unreadable ? Math.max(prevSeq + 1, now) : prevSeq + 1;
  const next = { schema: 1, killed: want, reason: String(reason).slice(0, 500), by: String(by).slice(0, 200), at: new Date(now).toISOString(), seq };
  await putMutable(state, PATHS.kill, next);
  const back = await readJsonObject(state, PATHS.kill);
  if (back.state !== 'ok' || !back.value || back.value.killed !== want || back.value.seq !== seq) {
    throw new Error(`setKill: kill.json changed under us (now ${back.state === 'ok' ? `killed=${back.value && back.value.killed} seq=${back.value && back.value.seq}` : back.state})`);
  }
  return next;
}

/**
 * A kill state the reader can act on. Fails CLOSED on anything but a valid
 * kill.json: missing (setupStore seeds it before any reader exists, so a
 * missing file means something deleted it), unreadable or malformed all mean
 * killed, and the reader renders the build.
 */
function effectiveKill(read) {
  if (read.state !== 'ok' || !read.value || typeof read.value.killed !== 'boolean') {
    return { killed: true, reason: `kill.json ${read.state === 'ok' ? 'malformed' : read.state}` };
  }
  return { killed: read.value.killed, reason: read.value.reason || '' };
}

/**
 * Create the private bucket and seed the kill / home rows if absent.
 * Refuses a bucket that exists but is public (it would serve internal objects to anyone).
 */
async function setupStore(storage, state, { by = 'setup' } = {}) {
  const created = await storage.ensureBucket();
  const meta = await storage.getBucket();
  if (!meta) throw new Error('setupStore: bucket missing after ensureBucket');
  if (meta.public !== false) throw new Error(`setupStore: bucket ${storage.bucket} is public; it must be private`);
  const seeded = [];
  const kill = await readJsonObject(state, PATHS.kill);
  if (kill.state === 'error') throw new Error(`setupStore: kill row unreadable (${kill.error})`);
  if (kill.state === 'missing') { await setKill(state, { killed: false, reason: 'initial', by }); seeded.push('kill'); }
  const home = await readJsonObject(state, PATHS.home);
  if (home.state === 'error') throw new Error(`setupStore: home row unreadable (${home.error})`);
  if (home.state === 'missing') { await putMutable(state, PATHS.home, HOME_PLACEHOLDER); seeded.push('home'); }
  return { bucket: created, seeded };
}

module.exports = {
  BUCKET, CACHE, PATHS, HOME_PLACEHOLDER, STATE_TABLE, STATE_KEYS,
  showObjectPath, isReaderPath, makeStateTable, storeFromEnv, readerStoreFromEnv, stateFromEnv, readerStateFromEnv,
  readJsonObject, isObjectMissing, canonical, putMutable, putShowObject,
  setKill, effectiveKill, setupStore,
};
