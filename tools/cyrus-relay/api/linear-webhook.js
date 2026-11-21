import { createHmac, timingSafeEqual } from 'node:crypto';
import { put } from '@vercel/blob';
import { encrypt } from './_crypto.js';

// bodyParser off so the exact bytes Linear signed survive the trip to Cyrus.
export const config = { api: { bodyParser: false } };

// Headers Cyrus needs to verify the Linear signature. Everything else is dropped.
const FORWARD_HEADERS = [
  'content-type',
  'linear-signature',
  'linear-delivery',
  'linear-event',
  'user-agent',
];

const MAX_BODY_BYTES = 512 * 1024;

// A delivery Linear signed months ago is still validly signed. Anything whose
// own timestamp is outside this window is a replay, not a delivery.
const MAX_DELIVERY_AGE_MS = 5 * 60 * 1000;

function replayWindowVerdict(rawBody) {
  let stamp;
  try {
    const parsed = JSON.parse(rawBody);
    stamp = parsed.webhookTimestamp ?? parsed.createdAt;
  } catch {
    return { ok: false, reason: 'unparseable body' };
  }
  if (stamp === undefined || stamp === null) {
    // Linear has always sent one; if a payload shape ever drops it, fail closed
    // rather than quietly losing the only replay defence.
    return { ok: false, reason: 'no webhookTimestamp' };
  }
  const ms = typeof stamp === 'number' ? stamp : Date.parse(stamp);
  if (!Number.isFinite(ms)) return { ok: false, reason: 'unreadable webhookTimestamp' };
  const age = Date.now() - ms;
  // Allow a little clock skew in the future direction.
  if (age > MAX_DELIVERY_AGE_MS || age < -MAX_DELIVERY_AGE_MS) {
    return { ok: false, reason: `outside replay window (${Math.round(age / 1000)}s)` };
  }
  return { ok: true };
}

function signatureMatches(secret, rawBody, signature) {
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readRawBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new Error('payload too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('method not allowed');

  // Fail CLOSED on either missing secret. Cyrus runs Claude Code with write
  // access to a real repo, so an unauthenticated payload that reaches it is
  // remote code execution — a cleared env var must take the endpoint offline,
  // never downgrade it to "accept anything carrying a signature header".
  const secret = process.env.RELAY_SECRET;
  const webhookSecret = process.env.LINEAR_WEBHOOK_SECRET;
  if (!secret || !webhookSecret) return res.status(503).send('relay not configured');

  let raw;
  try {
    raw = await readRawBody(req);
  } catch {
    return res.status(413).send('payload too large');
  }
  // Belt and braces: if some layer already drained the stream, fall back to the
  // parsed body. Re-serialised bytes may not match the signature, so the drain
  // script flags these.
  let rawExact = true;
  if (!raw && req.body) {
    raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    rawExact = false;
  }

  const headers = {};
  for (const name of FORWARD_HEADERS) {
    const v = req.headers[name];
    if (v) headers[name] = Array.isArray(v) ? v[0] : v;
  }

  // Linear signs every delivery; an unsigned POST is junk from the open
  // internet and Cyrus would reject it anyway. Drop it so the queue stays clean.
  if (!headers['linear-signature']) {
    return res.status(401).send('missing linear-signature');
  }

  // The relay is a public URL, so verify the signature here too rather than
  // letting anything that merely *has* the header take up space in the queue.
  if (!signatureMatches(webhookSecret, raw, headers['linear-signature'])) {
    return res.status(401).send('bad linear-signature');
  }

  // Only after the signature checks out — parsing attacker-controlled JSON
  // before authentication is free work for anyone who wants it.
  const replay = replayWindowVerdict(raw);
  if (!replay.ok) {
    return res.status(401).send(`rejected: ${replay.reason}`);
  }

  const envelope = JSON.stringify({
    receivedAt: new Date().toISOString(),
    rawExact,
    headers,
    body: raw,
  });

  const pathname = `q/${Date.now()}-${crypto.randomUUID()}.enc`;
  await put(pathname, await encrypt(secret, envelope), {
    access: 'public',
    contentType: 'text/plain',
    addRandomSuffix: true,
  });

  return res.status(200).json({ queued: true });
}
