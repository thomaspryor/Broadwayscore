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
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `cyrus-webhook-drain.js — pull queued Linear webhook deliveries from the
Vercel relay and replay each one byte-for-byte at the local Cyrus edge worker.
Outbound only; nothing inbound is ever opened on this machine.

Usage:
  node scripts/cyrus-webhook-drain.js                 drain forever (default)
  node scripts/cyrus-webhook-drain.js --once          drain a single batch and exit
  node scripts/cyrus-webhook-drain.js --interval=2000 poll interval in ms (default 2000)
  node scripts/cyrus-webhook-drain.js --help, -h      print this usage and exit

Env:   CYRUS_RELAY_URL (default https://cyrus-relay.vercel.app), CYRUS_HOME (~/.cyrus)
Secret: CYRUS_RELAY_SECRET from the env or ~/.cyrus/.env (shared with the relay)
Log:    ~/.cyrus/webhook-drain.log
`;

const RELAY_URL = process.env.CYRUS_RELAY_URL || 'https://cyrus-relay.vercel.app';
const CYRUS_HOME = process.env.CYRUS_HOME || path.join(os.homedir(), '.cyrus');
const LOG_PATH = path.join(CYRUS_HOME, 'webhook-drain.log');
const STATUS_PATH = path.join(CYRUS_HOME, 'webhook-drain-status.json');

// Every network call gets a deadline. Without one, a single connection that
// never resolves parks the only drain loop forever and Cyrus goes quiet with
// nothing in the log to say so.
const FETCH_TIMEOUT_MS = 20000;

// A delivery nobody has been able to hand to Cyrus for this long is not going
// to become useful — Linear has already moved on. Dropping it loudly is better
// than letting it sit at the head of the queue starving newer events.
const MAX_ITEM_AGE_MS = 30 * 60 * 1000;

// Cyrus answers 400/401 both for genuinely bad payloads and, briefly, while it
// is restarting under a rotated secret. Retry a few times before believing it.
const MAX_REJECT_ATTEMPTS = 5;

// Warn when the queue is visibly backing up rather than waiting for someone to
// notice Cyrus has been silent for a day.
const BACKLOG_WARN_AGE_SECONDS = 300;

const attemptsByUrl = new Map();

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

function fetchWithTimeout(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

function writeStatus(fields) {
  try {
    fs.writeFileSync(STATUS_PATH, `${JSON.stringify({ ...fields, at: new Date().toISOString() }, null, 2)}\n`);
  } catch {
    /* status is a convenience, never a reason to stop draining */
  }
}

async function drainOnce(secret, port) {
  const res = await fetchWithTimeout(`${RELAY_URL}/api/drain`, {
    headers: { authorization: `Bearer ${secret}` },
  });
  if (!res.ok) throw new Error(`drain GET ${res.status}: ${(await res.text()).slice(0, 200)}`);

  const { items, depth = 0, oldestAgeSeconds = 0, unreadable = 0 } = await res.json();

  writeStatus({ ok: true, depth, oldestAgeSeconds, unreadable, batch: items.length });
  if (unreadable) log(`WARN ${unreadable} queued blob(s) could not be read back from storage`);
  if (oldestAgeSeconds > BACKLOG_WARN_AGE_SECONDS) {
    log(`WARN queue backing up: depth=${depth} oldest=${oldestAgeSeconds}s`);
  }
  if (!items.length) {
    attemptsByUrl.clear();
    return 0;
  }

  const done = [];
  for (const item of items) {
    const attempts = (attemptsByUrl.get(item.url) || 0) + 1;
    attemptsByUrl.set(item.url, attempts);

    const ageMs = item.queuedAtMs ? Date.now() - item.queuedAtMs : 0;
    if (ageMs > MAX_ITEM_AGE_MS) {
      log(`DROP stale ${item.pathname} after ${Math.round(ageMs / 60000)}m undelivered`);
      done.push(item.url);
      continue;
    }

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
      const forward = await fetchWithTimeout(`http://127.0.0.1:${port}/linear-webhook`, {
        method: 'POST',
        headers: envelope.headers,
        body: envelope.body,
      });
      const detail = `${event} queued=${envelope.receivedAt} -> ${forward.status}`;
      if (forward.ok) {
        log(`DELIVERED ${detail}`);
        done.push(item.url);
      } else if (forward.status === 401 || forward.status === 400) {
        // Usually a genuinely bad payload — but Cyrus also answers 401 for the
        // few seconds it runs with a stale secret after a restart, and dropping
        // there loses a real event for good. Give it a handful of tries first.
        if (attempts >= MAX_REJECT_ATTEMPTS) {
          log(`DROP ${detail} after ${attempts} attempts exact=${envelope.rawExact !== false}`);
          done.push(item.url);
        } else {
          log(`RETRY ${detail} (rejected, attempt ${attempts}/${MAX_REJECT_ATTEMPTS})`);
        }
      } else {
        log(`RETRY ${detail} (attempt ${attempts})`);
      }
    } catch (err) {
      log(`RETRY ${event}: local Cyrus unreachable (${err.message})`);
    }
  }

  if (done.length) {
    const ack = await fetchWithTimeout(`${RELAY_URL}/api/drain`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ urls: done }),
    });
    if (ack.ok) {
      for (const url of done) attemptsByUrl.delete(url);
    } else {
      // The blobs survive, so the next poll redelivers them. Cyrus dedupes on
      // its own session ids; a duplicate is far better than a dropped event.
      log(`WARN ack failed ${ack.status} — ${done.length} item(s) will be redelivered`);
    }
  }

  return items.length;
}

async function main() {
  // --help/-h BEFORE readRelaySecret()/log()/fetch(): this script reads a secret
  // off disk, appends to ~/.cyrus/webhook-drain.log, then enters an unbounded
  // network poll loop against the relay and the local Cyrus worker — real side
  // effects on --help, the class the help-flag safety audit blocks on (it
  // reddened Lint Workflows in run 31863276943). Without the gate, `--help` on a
  // machine with no ~/.cyrus/.env exits 1 with a FATAL stack instead of usage.
  if (hasHelpFlag(args)) {
    console.log(USAGE);
    return;
  }

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
      // Record the failure too: a status file that only updates on success is
      // indistinguishable from a stopped process.
      writeStatus({ ok: false, error: err.message });
      backoff = Math.min(backoff * 2, 60000);
    }
    await new Promise((resolve) => setTimeout(resolve, backoff));
  }
}

main().catch((err) => {
  log(`FATAL ${err.stack || err.message}`);
  process.exit(1);
});
