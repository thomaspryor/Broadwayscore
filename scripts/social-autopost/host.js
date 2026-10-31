/**
 * Encode a rendered card for the networks and host it at a stable public URL.
 *
 * Buffer has no upload endpoint: it fetches media from a public URL when the
 * post goes out, which can be hours later, so the URL must not expire
 * (developers.buffer.com/guides/hosting-media). Supabase Storage public
 * buckets give permanent URLs and the project already holds a service key.
 *
 * JPEG, because Instagram's publishing API takes JPEG only, and under 950 KB
 * because Bluesky rejects images over 1,000,000 bytes.
 */

const BUCKET = 'social-cards';
const MAX_BYTES = 950 * 1024;

function supabaseEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return { url: url.replace(/\/$/, ''), key };
}

/** PNG path -> JPEG buffer under MAX_BYTES, keeping 2160px wide when it fits. */
async function encodeForSocial(pngPath) {
  const sharp = require('sharp');
  const tries = [[2160, 90], [2160, 84], [1800, 86], [1440, 86], [1440, 78]];
  let last = null;
  for (const [width, quality] of tries) {
    last = await sharp(pngPath).resize({ width, withoutEnlargement: true })
      .jpeg({ quality, mozjpeg: true, chromaSubsampling: width >= 2160 ? '4:4:4' : '4:2:0' }).toBuffer();
    if (last.length <= MAX_BYTES) return { buffer: last, width, quality };
  }
  throw new Error(`card JPEG still ${last.length} bytes at the smallest setting`);
}

const FETCH_TIMEOUT_MS = 30000;

async function ensureBucket(env, bucket = BUCKET, opts = { public: true, allowed_mime_types: ['image/jpeg'], file_size_limit: 5 * 1024 * 1024 }) {
  const headers = { apikey: env.key, Authorization: `Bearer ${env.key}`, 'Content-Type': 'application/json' };
  const res = await fetch(`${env.url}/storage/v1/bucket/${bucket}`, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (res.ok) return;
  const create = await fetch(`${env.url}/storage/v1/bucket`, {
    method: 'POST', headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    body: JSON.stringify({ id: bucket, name: bucket, ...opts }),
  });
  if (!create.ok && create.status !== 409) throw new Error(`create bucket ${bucket}: HTTP ${create.status} ${await create.text()}`);
}

// Brief posts (BRO-6368): the preview's manifest (captions, facts, image URL) and the
// owner's approval are stored here, keyed by the brief hash, so the workflow posts
// exactly what was shown. Private: only the service key reads it.
const BRIEF_BUCKET = 'social-briefs';

/** Store a JSON object at social-briefs/<hash>/<name>. */
async function putBriefFile(hash, name, obj) {
  const env = supabaseEnv();
  if (!env) throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set; cannot store the brief');
  await ensureBucket(env, BRIEF_BUCKET, { public: false, allowed_mime_types: ['application/json'], file_size_limit: 256 * 1024 });
  const res = await fetch(`${env.url}/storage/v1/object/${BRIEF_BUCKET}/${hash}/${name}`, {
    method: 'POST',
    headers: { apikey: env.key, Authorization: `Bearer ${env.key}`, 'Content-Type': 'application/json', 'x-upsert': 'true' },
    body: JSON.stringify(obj),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`store brief ${hash}/${name}: HTTP ${res.status} ${await res.text()}`);
}

/** Read social-briefs/<hash>/<name>; null when it does not exist. */
async function getBriefFile(hash, name) {
  const env = supabaseEnv();
  if (!env) throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set; cannot read the brief');
  const res = await fetch(`${env.url}/storage/v1/object/authenticated/${BRIEF_BUCKET}/${hash}/${name}`, {
    headers: { apikey: env.key, Authorization: `Bearer ${env.key}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.status === 404 || res.status === 400) return null; // Supabase answers 400 "Object not found" for a missing key
  if (!res.ok) throw new Error(`read brief ${hash}/${name}: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

/** Upload and return the public URL. `key` like '2026/10/beaches-2026-score.jpg'. */
async function hostImage(buffer, key) {
  const env = supabaseEnv();
  if (!env) throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set; cannot host the card');
  await ensureBucket(env);
  const res = await fetch(`${env.url}/storage/v1/object/${BUCKET}/${key}`, {
    method: 'POST',
    headers: { apikey: env.key, Authorization: `Bearer ${env.key}`, 'Content-Type': 'image/jpeg', 'x-upsert': 'true', 'Cache-Control': 'max-age=31536000' },
    body: buffer,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`upload ${key}: HTTP ${res.status} ${await res.text()}`);
  const publicUrl = `${env.url}/storage/v1/object/public/${BUCKET}/${key}`;
  // Buffer fetches this later; prove it is publicly readable now.
  const check = await fetch(publicUrl, { method: 'HEAD', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!check.ok) throw new Error(`hosted card not publicly readable: HTTP ${check.status} ${publicUrl}`);
  return publicUrl;
}

module.exports = { encodeForSocial, hostImage, putBriefFile, getBriefFile, BUCKET, BRIEF_BUCKET, MAX_BYTES };
