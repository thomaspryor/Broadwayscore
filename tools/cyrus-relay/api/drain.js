import { list, del } from '@vercel/blob';

// GET  /api/drain            -> { items: [{ url, pathname, ciphertext }] }
// POST /api/drain  {urls:[]} -> deletes the acknowledged blobs
// Both require Authorization: Bearer <RELAY_SECRET>.

const MAX_BATCH = 20;

export default async function handler(req, res) {
  const secret = process.env.RELAY_SECRET;
  if (!secret) return res.status(500).send('relay not configured');

  if ((req.headers.authorization || '') !== `Bearer ${secret}`) {
    return res.status(401).send('unauthorized');
  }

  if (req.method === 'POST') {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const urls = Array.isArray(body.urls) ? body.urls : [];
    // Deleting is authenticated, but the bearer should still only be able to
    // reach this queue — not every blob in the store.
    const queueUrls = urls.filter((u) => typeof u === 'string' && u.includes('/q/'));
    const rejected = urls.length - queueUrls.length;
    if (queueUrls.length) await del(queueUrls);
    return res.status(200).json({ deleted: queueUrls.length, rejected });
  }

  if (req.method !== 'GET') return res.status(405).send('method not allowed');

  // Depth/age are computed over the whole queue, not just this batch, so a
  // backlog is visible even while the drain is chewing through the head of it.
  const { blobs: allBlobs } = await list({ prefix: 'q/' });
  const oldestAgeSeconds = allBlobs.length
    ? Math.round((Date.now() - Math.min(...allBlobs.map((b) => queuedAtMs(b.pathname)))) / 1000)
    : 0;

  const batch = [...allBlobs]
    // Oldest first: the pathname is prefixed with the receive timestamp.
    .sort((a, b) => a.pathname.localeCompare(b.pathname))
    .slice(0, MAX_BATCH);

  const items = [];
  let unreadable = 0;
  for (const b of batch) {
    const r = await fetch(b.url, { cache: 'no-store' });
    if (!r.ok) {
      unreadable += 1;
      continue;
    }
    items.push({
      url: b.url,
      pathname: b.pathname,
      queuedAtMs: queuedAtMs(b.pathname),
      ciphertext: await r.text(),
    });
  }

  return res.status(200).json({ items, depth: allBlobs.length, oldestAgeSeconds, unreadable });
}

// Pathnames look like q/<epoch-ms>-<uuid>[-<vercel suffix>].enc
function queuedAtMs(pathname) {
  const ms = Number(pathname.slice(2).split('-')[0]);
  return Number.isFinite(ms) ? ms : Date.now();
}
