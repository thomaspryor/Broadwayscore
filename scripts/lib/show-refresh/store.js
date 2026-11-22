'use strict';
/**
 * BRO-8056 phase 1c: the private `show-refresh` store (plan v14-final §1.2).
 *
 *   show/<id>/<hash>.json   immutable slice objects (1-year cache)
 *   home.json               index the reader follows (no-cache)
 *   kill.json               kill switch (no-cache)
 *   covered.json, health.json, flagged/<sha>.json  (later phases; no-cache)
 *
 * Writes need the service-role key and happen only in CI (single writer, R4).
 * The site reader never holds a key: it gets long-lived signed URLs for
 * home.json and kill.json (readerUrls), and home.json names a signed URL per
 * show object. A leaked URL reads one object of already-public page data;
 * held (unrevealed) shows are never published. A signed URL is tied to the
 * PATH (it survives overwrites) and cannot be revoked one at a time:
 * rotation = re-sign (`show-refresh-store.js --reader-urls`), update the
 * Vercel env, redeploy. Why private at all (plan v14-final 1.2): covered.json,
 * health.json and flagged/ are internal state, and the bucket is never
 * listable or enumerable without a credential. Revisit before phase 3a if the
 * per-object signing cost outweighs that.
 *
 * Every read returns { state: 'ok' | 'missing' | 'error' } so a caller can
 * tell "not there" from "store down" (an error is never treated as "unkilled").
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
});
/** Signed reader URLs last 10 years; rotation = re-sign and update the env var. */
const READER_URL_SECONDS = 10 * 365 * 24 * 3600;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,120}$/;
const HASH_RE = /^[0-9a-f]{16}$/;
const HOME_PLACEHOLDER = Object.freeze({ schema: 1, manifestId: null, coreSha: null, generation: 0, shows: {}, pending: {} });

function showObjectPath(id, hash) {
  if (!ID_RE.test(String(id))) throw new Error(`show-refresh: bad show id ${JSON.stringify(id)}`);
  if (!HASH_RE.test(String(hash))) throw new Error(`show-refresh: bad slice hash ${JSON.stringify(hash)}`);
  return `show/${id}/${hash}.json`;
}

/** Store client from env. Throws when the URL or key is missing (writers only). */
function storeFromEnv(env = process.env, { timeoutMs = 10000, fetchImpl } = {}) {
  const baseUrl = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!baseUrl || !serviceKey) throw new Error('show-refresh store: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY are required');
  return makeStorage({ baseUrl, serviceKey, bucket: env.SHOW_REFRESH_BUCKET || BUCKET, isPublic: false, timeoutMs, ...(fetchImpl ? { fetchImpl } : {}) });
}

/**
 * Supabase answers a missing OBJECT with 404, or 400 {"statusCode":"404",
 * "error":"not_found","message":"Object not found"}. A missing BUCKET
 * ("Bucket not found") is an error, not "missing": effectiveKill would read
 * missing kill.json as "not killed" and fail open.
 */
function isObjectMissing(r) {
  const t = r.text || '';
  if (/bucket/i.test(t)) return false;
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

/** Write a mutable JSON object (no-cache) and read it back. Returns the text written. */
async function putMutable(storage, path, value) {
  const text = JSON.stringify(value);
  await putVerified(storage, path, text, { cacheControl: CACHE.mutable, cacheBust: Date.now() });
  return text;
}

/** Write one immutable slice object and read it back. */
async function putShowObject(storage, id, hash, text) {
  const path = showObjectPath(id, hash);
  await putVerified(storage, path, text, { cacheControl: CACHE.immutable });
  return path;
}

/**
 * Kill state. Reads the current kill.json so seq always increases; an
 * unreadable kill.json (store error) aborts rather than overwriting blind.
 */
async function setKill(storage, { killed, reason = '', by = '', now = Date.now() }) {
  const cur = await readJsonObject(storage, PATHS.kill);
  if (cur.state === 'error') throw new Error(`setKill: kill.json unreadable (${cur.error})`);
  const seq = (cur.state === 'ok' && Number.isInteger(cur.value.seq) ? cur.value.seq : 0) + 1;
  const next = { schema: 1, killed: Boolean(killed), reason: String(reason).slice(0, 500), by: String(by).slice(0, 200), at: new Date(now).toISOString(), seq };
  await putMutable(storage, PATHS.kill, next);
  return next;
}

/**
 * A kill state the reader can act on. Missing kill.json = not killed (fresh
 * store); an unreadable one = killed (fail closed: the reader renders the build).
 */
function effectiveKill(read) {
  if (read.state === 'missing') return { killed: false, reason: 'no kill.json' };
  if (read.state !== 'ok' || !read.value || typeof read.value.killed !== 'boolean') return { killed: true, reason: `kill.json ${read.state === 'ok' ? 'malformed' : read.state}` };
  return { killed: read.value.killed, reason: read.value.reason || '' };
}

/**
 * Create the private bucket and seed kill.json / home.json if absent.
 * Refuses a bucket that exists but is public (it would serve slices to anyone).
 */
async function setupStore(storage, { by = 'setup' } = {}) {
  const created = await storage.ensureBucket();
  const meta = await storage.getBucket();
  if (!meta) throw new Error('setupStore: bucket missing after ensureBucket');
  if (meta.public !== false) throw new Error(`setupStore: bucket ${storage.bucket} is public; it must be private`);
  const seeded = [];
  const kill = await readJsonObject(storage, PATHS.kill);
  if (kill.state === 'error') throw new Error(`setupStore: kill.json unreadable (${kill.error})`);
  if (kill.state === 'missing') { await setKill(storage, { killed: false, reason: 'initial', by }); seeded.push(PATHS.kill); }
  const home = await readJsonObject(storage, PATHS.home);
  if (home.state === 'error') throw new Error(`setupStore: home.json unreadable (${home.error})`);
  if (home.state === 'missing') { await putMutable(storage, PATHS.home, HOME_PLACEHOLDER); seeded.push(PATHS.home); }
  return { bucket: created, seeded };
}

/** Signed read-only URLs for the reader (home.json, kill.json). */
async function readerUrls(storage, { expiresIn = READER_URL_SECONDS } = {}) {
  return {
    SHOW_REFRESH_HOME_URL: await storage.signUrl(PATHS.home, expiresIn),
    SHOW_REFRESH_KILL_URL: await storage.signUrl(PATHS.kill, expiresIn),
  };
}

module.exports = {
  BUCKET, CACHE, PATHS, READER_URL_SECONDS, HOME_PLACEHOLDER,
  showObjectPath, storeFromEnv, readJsonObject, isObjectMissing, putMutable, putShowObject,
  setKill, effectiveKill, setupStore, readerUrls,
};
