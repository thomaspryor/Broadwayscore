'use strict';
// BRO-7803: tiny Supabase Storage client for the public `live-scores` bucket.
// fetch is injectable so tests can run against a local HTTP server.

const DEFAULT_BUCKET = 'live-scores';

function makeStorage({ baseUrl, serviceKey, bucket = DEFAULT_BUCKET, fetchImpl = fetch }) {
  const root = String(baseUrl).replace(/\/$/, '') + '/storage/v1';
  const auth = serviceKey ? { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey } : {};

  async function ensureBucket() {
    const res = await fetchImpl(`${root}/bucket`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ id: bucket, name: bucket, public: true }),
    });
    if (res.ok) return 'created';
    const text = await res.text().catch(() => '');
    if (res.status === 409 || /already exists|Duplicate/i.test(text)) return 'exists';
    throw new Error(`ensureBucket ${res.status} ${text.slice(0, 200)}`);
  }

  async function put(path, text, { cacheSeconds, contentType = 'application/json' } = {}) {
    const res = await fetchImpl(`${root}/object/${bucket}/${path}`, {
      method: 'POST',
      headers: {
        ...auth,
        'content-type': contentType,
        'x-upsert': 'true',
        'cache-control': `max-age=${cacheSeconds ?? 31536000}`,
      },
      body: text,
    });
    if (!res.ok) throw new Error(`put ${path} ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  }

  /** Public GET. Returns { status, text, headers }. cacheBust appends ?t=. */
  async function get(path, { cacheBust } = {}) {
    const q = cacheBust != null ? `?t=${cacheBust}` : '';
    const res = await fetchImpl(`${root}/object/public/${bucket}/${path}${q}`);
    return { status: res.status, text: res.ok ? await res.text() : '', headers: res.headers };
  }

  async function remove(path) {
    const res = await fetchImpl(`${root}/object/${bucket}/${path}`, { method: 'DELETE', headers: auth });
    if (!res.ok && res.status !== 404) throw new Error(`remove ${path} ${res.status}`);
  }

  return { ensureBucket, put, get, remove, bucket };
}

module.exports = { makeStorage, DEFAULT_BUCKET };
