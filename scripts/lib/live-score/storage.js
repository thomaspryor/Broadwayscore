'use strict';
// BRO-7803: tiny Supabase Storage client for the public `live-scores` bucket.
// BRO-8056 1c: also serves the private `show-refresh` bucket (isPublic:false
// reads through the authenticated endpoint), with an optional per-request
// timeout and a per-object cache-control string.
// fetch is injectable so tests can run against a local HTTP server.

const DEFAULT_BUCKET = 'live-scores';
const YEAR_SECONDS = 31536000;

/**
 * @param {object} o
 * @param {string} o.baseUrl - Supabase project URL
 * @param {string} [o.serviceKey] - service-role key (writes, private reads)
 * @param {string} [o.bucket]
 * @param {boolean} [o.isPublic=true] - bucket visibility for ensureBucket, and which GET endpoint reads use
 * @param {number} [o.timeoutMs] - abort any single request after this long (default: no limit)
 */
function makeStorage({ baseUrl, serviceKey, bucket = DEFAULT_BUCKET, isPublic = true, timeoutMs, fetchImpl = fetch }) {
  const root = String(baseUrl).replace(/\/$/, '') + '/storage/v1';
  const auth = serviceKey ? { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey } : {};
  const call = (url, init = {}) => fetchImpl(url, timeoutMs ? { ...init, signal: AbortSignal.timeout(timeoutMs) } : init);

  async function ensureBucket() {
    const res = await call(`${root}/bucket`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ id: bucket, name: bucket, public: isPublic }),
    });
    if (res.ok) return 'created';
    const text = await res.text().catch(() => '');
    if (res.status === 409 || /already exists|Duplicate/i.test(text)) return 'exists';
    throw new Error(`ensureBucket ${res.status} ${text.slice(0, 200)}`);
  }

  /** Bucket metadata ({ id, public, ... }), or null when it does not exist. */
  async function getBucket() {
    const res = await call(`${root}/bucket/${bucket}`, { headers: auth });
    if (res.ok) return res.json();
    const text = (await res.text().catch(() => '')).slice(0, 500);
    // Supabase answers a missing bucket with 404, or 400 {"statusCode":"404",
    // "error":"Bucket not found"}. Any other 400 (bad key, bad request) is a failure.
    if (res.status === 404 || (res.status === 400 && /not.?found/i.test(text))) return null;
    throw new Error(`getBucket ${res.status} ${text.slice(0, 200)}`);
  }

  /** cacheControl (a full header value) wins over cacheSeconds (max-age only). */
  async function put(path, text, { cacheSeconds, cacheControl, contentType = 'application/json' } = {}) {
    const res = await call(`${root}/object/${bucket}/${path}`, {
      method: 'POST',
      headers: {
        ...auth,
        'content-type': contentType,
        'x-upsert': 'true',
        'cache-control': cacheControl || `max-age=${cacheSeconds ?? YEAR_SECONDS}`,
      },
      body: text,
    });
    if (!res.ok) throw new Error(`put ${path} ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  }

  /** GET (public endpoint, or authenticated for a private bucket). Returns { status, text, headers }. cacheBust appends ?t=. */
  async function get(path, { cacheBust } = {}) {
    const q = cacheBust != null ? `?t=${cacheBust}` : '';
    const url = isPublic ? `${root}/object/public/${bucket}/${path}${q}` : `${root}/object/authenticated/${bucket}/${path}${q}`;
    const res = await call(url, isPublic ? {} : { headers: auth });
    // Error bodies are kept (first 500 chars) so a caller can tell Supabase's
    // 400 {"statusCode":"404"} "missing" apart from a real failure.
    const text = res.ok ? await res.text() : (await res.text().catch(() => '')).slice(0, 500);
    return { status: res.status, text, headers: res.headers };
  }

  /** A read-only URL for one object, valid expiresIn seconds. */
  async function signUrl(path, expiresIn) {
    const res = await call(`${root}/object/sign/${bucket}/${path}`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ expiresIn }),
    });
    if (!res.ok) throw new Error(`signUrl ${path} ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
    const body = await res.json();
    const rel = body.signedURL || body.signedUrl;
    if (!rel) throw new Error(`signUrl ${path}: no signedURL in response`);
    return /^https?:/.test(rel) ? rel : `${root}${rel.startsWith('/') ? '' : '/'}${rel}`;
  }

  async function remove(path) {
    const res = await call(`${root}/object/${bucket}/${path}`, { method: 'DELETE', headers: auth });
    if (!res.ok && res.status !== 404) throw new Error(`remove ${path} ${res.status}`);
  }

  return { ensureBucket, getBucket, put, get, signUrl, remove, bucket, isPublic };
}

/**
 * Upload, then read back and compare byte-for-byte (BRO-7803 publish order,
 * shared with show-refresh). Throws on mismatch so the caller never advances a
 * pointer past an object that is not really there.
 */
async function putVerified(storage, path, text, opts = {}) {
  await storage.put(path, text, opts);
  const back = await storage.get(path, { cacheBust: opts.cacheBust });
  if (back.status !== 200 || back.text !== text) throw new Error(`verify mismatch for ${path} (status ${back.status})`);
}

module.exports = { makeStorage, putVerified, DEFAULT_BUCKET, YEAR_SECONDS };
