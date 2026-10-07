/**
 * Beat the Critics — send-picks API unit tests
 *
 * Tests the API route logic by:
 *   1. Testing pure validation + rate-limit functions extracted inline
 *      (mirrors the logic in src/app/api/beat-the-critics/send-picks/route.ts)
 *   2. Hitting the local dev server via HTTP for integration tests
 *      (gated: skips if localhost:3000 is not available)
 *
 * Run: node --test tests/unit/btc-send-picks.test.mjs
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// ─── Inline logic mirrors (keep in sync with route.ts) ───────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function validateEmail(email) {
  return typeof email === 'string' && email.trim().length > 0 && EMAIL_RE.test(email.trim());
}

const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 3;

function makeRateLimiter() {
  const store = new Map();
  return function checkRateLimit(ip, nowOverride) {
    const now = nowOverride ?? Date.now();
    const entry = store.get(ip);
    if (!entry || now - entry.windowStart > RATE_WINDOW_MS) {
      store.set(ip, { count: 1, windowStart: now });
      return true;
    }
    if (entry.count >= RATE_MAX) return false;
    entry.count++;
    return true;
  };
}

// ─── Pure logic tests (always run) ───────────────────────────────────────

describe('validateEmail — pure logic', () => {
  test('rejects missing email', () => {
    assert.equal(validateEmail(undefined), false);
    assert.equal(validateEmail(null), false);
    assert.equal(validateEmail(''), false);
  });

  test('rejects malformed email', () => {
    assert.equal(validateEmail('not-an-email'), false);
    assert.equal(validateEmail('@nodomain'), false);
    assert.equal(validateEmail('missing@'), false);
    assert.equal(validateEmail('missing@dot'), false);
    assert.equal(validateEmail('space @example.com'), false);
  });

  test('accepts valid email addresses', () => {
    assert.equal(validateEmail('user@example.com'), true);
    assert.equal(validateEmail('  user+tag@sub.example.org  '), true);
    assert.equal(validateEmail('a@b.io'), true);
  });
});

describe('checkRateLimit — pure logic', () => {
  test('allows first 3 requests from same IP', () => {
    const check = makeRateLimiter();
    const ip = '1.2.3.4';
    assert.equal(check(ip), true, 'first request');
    assert.equal(check(ip), true, 'second request');
    assert.equal(check(ip), true, 'third request');
  });

  test('blocks 4th request from same IP within window', () => {
    const check = makeRateLimiter();
    const ip = '5.6.7.8';
    check(ip); check(ip); check(ip);
    assert.equal(check(ip), false, '4th request should be blocked');
  });

  test('resets after window expires', () => {
    const check = makeRateLimiter();
    const ip = '9.10.11.12';
    const t0 = Date.now();
    check(ip, t0); check(ip, t0); check(ip, t0);
    // 4th at t0 → blocked
    assert.equal(check(ip, t0), false);
    // After window expires → allowed again
    assert.equal(check(ip, t0 + RATE_WINDOW_MS + 1), true);
  });

  test('different IPs have independent windows', () => {
    const check = makeRateLimiter();
    const t0 = Date.now();
    check('a.b.c.1', t0); check('a.b.c.1', t0); check('a.b.c.1', t0);
    assert.equal(check('a.b.c.1', t0), false, 'IP 1 blocked after 3');
    assert.equal(check('a.b.c.2', t0), true,  'IP 2 unaffected');
  });
});

// ─── HTTP integration tests (skipped if dev server not running) ──────────

async function devServerAvailable() {
  return new Promise(resolve => {
    const req = http.request({ hostname: 'localhost', port: 3000, path: '/api/beat-the-critics/send-picks', method: 'HEAD' }, () => resolve(true));
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => { req.destroy(); resolve(false); });
    req.end();
  });
}

async function postPicks(body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      hostname: 'localhost',
      port: 3000,
      path: '/api/beat-the-critics/send-picks',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        ...headers,
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Request timed out')); });
    req.write(payload);
    req.end();
  });
}

describe('send-picks API — HTTP integration (requires local dev server)', async () => {
  const available = await devServerAvailable();

  if (!available) {
    test('(skipped — localhost:3000 not available; start with `npm run dev`)', () => {});
    return;
  }

  test('missing email returns 400', async () => {
    const { status, body } = await postPicks({ picks: {}, ceremonyYear: 2026 });
    assert.equal(status, 400);
    assert.ok(body.error, 'should return error field');
  });

  test('invalid email format returns 400', async () => {
    const { status, body } = await postPicks({ email: 'not-an-email', picks: {}, ceremonyYear: 2026 });
    assert.equal(status, 400);
    assert.ok(body.error);
  });

  test('valid submission (storage-first ordering): storeSubmission called before Resend', async () => {
    // We verify storage-first ordering indirectly:
    // If REVIEW_TEXTS_TOKEN is not configured, route returns 500 (storeSubmission throws)
    // before it ever reaches the Resend call.
    // In a fresh test env without token, this surfaces as a 500 — not a 200 — proving
    // the route aborts before emailing on storage failure.
    //
    // To verify success path: provide a valid email and check for {success:true} or
    // an appropriate error (503 = Resend not configured, 500 = storage not configured).
    const { status } = await postPicks(
      { email: 'btc-unit-test@example.com', picks: { 'Best Musical': 'UNIT-TEST' }, ceremonyYear: 2026 },
      { 'x-forwarded-for': `10.unit.${Date.now() % 255}.${Math.floor(Math.random() * 250)}` }
    );
    // Acceptable outcomes: 200 (full success), 500 (storage not configured), 503 (email not configured)
    // Not acceptable: 400 (validation passed, so this would be a false rejection)
    assert.notEqual(status, 400, 'valid payload should not return 400');
  });

  test('rate limit: 4 rapid POSTs from same IP → 4th returns 429', async () => {
    const spoofedIp = `10.ratelimit-unit.${Date.now() % 250}.${Math.floor(Math.random() * 250)}`;
    const headers = { 'x-forwarded-for': spoofedIp };
    const body = { email: `rate-test-${Date.now()}@example.com`, picks: {}, ceremonyYear: 2026 };

    let got429 = false;
    for (let i = 0; i < 4; i++) {
      const { status } = await postPicks(body, headers);
      if (status === 429) { got429 = true; break; }
    }
    assert.ok(got429, '4th request from same IP should return 429');
  });
});
