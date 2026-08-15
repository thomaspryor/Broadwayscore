#!/usr/bin/env node
/**
 * Cyrus webhook drain.
 *
 * WHY THIS EXISTS
 * Cyrus needs Linear webhooks, and Linear can only POST to a public URL. This
 * Mac has no usable inbound path: the Tailscale node belongs to a corporate
 * tailnet (classdojo.com) whose funnel ingress does not route to it, and there
 * is no Cloudflare zone. So instead of exposing the Mac, Linear POSTs to a
 * Vercel relay (tools/cyrus-relay) that queues each delivery, and this script
 * pulls the queue outbound and replays each delivery byte-for-byte at the local
 * Cyrus edge worker. Nothing inbound is ever opened on this machine.
 *
 * Usage:  node scripts/cyrus-webhook-drain.js [--once] [--interval=2000]
 *
 * Secrets: CYRUS_RELAY_SECRET in ~/.cyrus/.env (shared with the relay).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const RELAY_URL = process.env.CYRUS_RELAY_URL || 'https://cyrus-relay.vercel.app';
const CYRUS_HOME = process.env.CYRUS_HOME || path.join(os.homedir(), '.cyrus');
const LOG_PATH = path.join(CYRUS_HOME, 'webhook-drain.log');

const args = process.argv.slice(2);
const ONCE = args.includes('--once');
const INTERVAL_MS = Number(
  (args.find((a) => a.startsWith('--interval=')) || '--interval=2000').split('=')[1]
);

function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.join(' ')}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_PATH, `${line}\n`);
  } catch {
    /* logging must never take the drain down */
  }
}

function readRelaySecret() {
  const envPath = path.join(CYRUS_HOME, '.env');
  if (process.env.CYRUS_RELAY_SECRET) return process.env.CYRUS_RELAY_SECRET;
  const text = fs.readFileSync(envPath, 'utf8');
  const match = text.match(/^CYRUS_RELAY_SECRET=(.+)$/m);
  if (!match) throw new Error(`CYRUS_RELAY_SECRET not found in ${envPath}`);
  return match[1].trim();
}

function readCyrusPort() {
  const envPath = path.join(CYRUS_HOME, '.env');
  try {
    const match = fs.readFileSync(envPath, 'utf8').match(/^PORT=(\d+)$/m);
    if (match) return Number(match[1]);
  } catch {
    /* fall through to the default */
  }
  return 3456;
}

function decrypt(secret, b64) {
  const buf = Buffer.from(b64, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const ciphertext = buf.subarray(12, buf.length - 16);
  const key = crypto.createHash('sha256').update(secret).digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

async function drainOnce(secret, port) {
  const res = await fetch(`${RELAY_URL}/api/drain`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  if (!res.ok) throw new Error(`drain GET ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const { items } = await res.json();
  if (!items.length) return 0;

  const done = [];
  for (const item of items) {
    let envelope;
    try {
      envelope = JSON.parse(decrypt(secret, item.ciphertext));
    } catch (err) {
      // Undecryptable means it was written under a different secret; it will
      // never become deliverable, so drop it rather than block the queue.
      log(`DROP undecryptable ${item.pathname}: ${err.message}`);
      done.push(item.url);
      continue;
    }

    const event = envelope.headers['linear-event'] || 'unknown';
    try {
      const forward = await fetch(`http://127.0.0.1:${port}/linear-webhook`, {
        method: 'POST',
        headers: envelope.headers,
        body: envelope.body,
      });
      const detail = `${event} queued=${envelope.receivedAt} -> ${forward.status}`;
      if (forward.ok) {
        log(`DELIVERED ${detail}`);
        done.push(item.url);
      } else if (forward.status === 401 || forward.status === 400) {
        // Cyrus rejected the payload itself (bad signature / malformed). It is
        // not going to accept it on a retry either.
        log(`REJECTED ${detail} exact=${envelope.rawExact !== false}`);
        done.push(item.url);
      } else {
        log(`RETRY ${detail}`);
      }
    } catch (err) {
      log(`RETRY ${event}: local Cyrus unreachable (${err.message})`);
    }
  }

  if (done.length) {
    const ack = await fetch(`${RELAY_URL}/api/drain`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ urls: done }),
    });
    if (!ack.ok) log(`WARN ack failed ${ack.status}`);
  }

  return items.length;
}

async function main() {
  const secret = readRelaySecret();
  const port = readCyrusPort();
  log(`START relay=${RELAY_URL} cyrus=http://127.0.0.1:${port} interval=${INTERVAL_MS}ms`);

  if (ONCE) {
    const n = await drainOnce(secret, port);
    log(`ONCE processed=${n}`);
    return;
  }

  let backoff = INTERVAL_MS;
  for (;;) {
    try {
      await drainOnce(secret, port);
      backoff = INTERVAL_MS;
    } catch (err) {
      log(`ERROR ${err.message}`);
      backoff = Math.min(backoff * 2, 60000);
    }
    await new Promise((resolve) => setTimeout(resolve, backoff));
  }
}

main().catch((err) => {
  log(`FATAL ${err.stack || err.message}`);
  process.exit(1);
});
