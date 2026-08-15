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
    const urls = body.urls;
    if (Array.isArray(urls) && urls.length) await del(urls);
    return res.status(200).json({ deleted: Array.isArray(urls) ? urls.length : 0 });
  }

  if (req.method !== 'GET') return res.status(405).send('method not allowed');

  const { blobs } = await list({ prefix: 'q/', limit: MAX_BATCH });
  // Oldest first: the pathname is prefixed with the receive timestamp.
  blobs.sort((a, b) => a.pathname.localeCompare(b.pathname));

  const items = [];
  for (const b of blobs) {
    const r = await fetch(b.url, { cache: 'no-store' });
    if (!r.ok) continue;
    items.push({ url: b.url, pathname: b.pathname, ciphertext: await r.text() });
  }

  return res.status(200).json({ items });
}
