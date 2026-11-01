import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const w = require('../../scripts/lib/money-welcome.js');

const row = (email, extra = {}) => ({ email, welcomed_at: null, unsubscribed_at: null, ...extra });

test('planWelcomes skips welcomed, unsubscribed, probe and owner test rows', () => {
  const rows = [
    row('a@real.org'),
    row('b@real.org', { welcomed_at: '2026-10-30' }),
    row('c@real.org', { unsubscribed_at: '2026-10-31' }),
    row('probe@example.com'),
    row('thomas.pryor+x@gmail.com'),
    row('roundtrip-1@real.org'),
  ];
  const p = w.planWelcomes(rows);
  assert.deepEqual(p.send.map((r) => r.email), ['a@real.org']);
  assert.equal(p.skipped.welcomed, 1);
  assert.equal(p.skipped.unsubscribed, 1);
  assert.equal(p.skipped.probe, 3);
});

test('planWelcomes caps a run', () => {
  const rows = Array.from({ length: 80 }, (_, i) => row(`u${i}@real.org`));
  const p = w.planWelcomes(rows);
  assert.equal(p.send.length, 50);
  assert.equal(p.skipped.over_cap, 30);
});

test('email has unsubscribe headers, footer and no em dashes', () => {
  const m = w.buildWelcomeEmail(row('Pat@Real.org'));
  assert.match(m.headers['List-Unsubscribe'], /mailto:hi@broadwayscorecard\.com/);
  assert.match(m.headers['List-Unsubscribe'], /list=money&email=pat%40real\.org/);
  assert.equal(m.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.ok(!/—/.test(m.text + m.html + m.subject));
  assert.match(m.text, /Unsubscribe:/);
  assert.match(m.html, />Unsubscribe</);
});

test('idempotency key hides the address and is stable', () => {
  const k = w.idempotencyKey('A@b.org', 's');
  assert.equal(k, w.idempotencyKey(' a@B.org ', 's'));
  assert.ok(!k.includes('b.org'));
});

test('resendOutcome and runAllowed', () => {
  assert.equal(w.resendOutcome(200), 'sent');
  assert.equal(w.resendOutcome(422), 'rejected');
  assert.equal(w.resendOutcome(429), 'retry');
  assert.equal(w.resendOutcome(0), 'retry');
  assert.equal(w.runAllowed({ enabled: undefined, preview: false }), false);
  assert.equal(w.runAllowed({ enabled: 'false', preview: false }), false);
  assert.equal(w.runAllowed({ enabled: 'true', preview: false }), true);
  assert.equal(w.runAllowed({ enabled: '', preview: true }), true);
});

test('sendWelcomes claims before sending, keeps claim on reject, releases and halts on retry', async () => {
  const claimed = [], released = [], sent = [];
  const rows = ['a', 'b', 'c', 'd'].map((n) => row(`${n}@real.org`));
  const codes = { 'a@real.org': 200, 'b@real.org': 422, 'c@real.org': 503, 'd@real.org': 200 };
  const out = await w.sendWelcomes(rows, {
    claim: async (e) => { claimed.push(e); return true; },
    release: async (e) => { released.push(e); },
    send: async (r) => { assert.ok(claimed.includes(r.email)); sent.push(r.email); return { statusCode: codes[r.email] }; },
  });
  assert.equal(out.sent, 1);
  assert.equal(out.rejected, 1);
  assert.equal(out.halted, true);
  assert.deepEqual(released, ['c@real.org']);
  assert.deepEqual(sent, ['a@real.org', 'b@real.org', 'c@real.org']);
});

test('sendWelcomes skips rows whose claim was lost', async () => {
  const out = await w.sendWelcomes([row('a@real.org')], {
    claim: async () => false, release: async () => {}, send: async () => { throw new Error('should not send'); },
  });
  assert.equal(out.lost_claim, 1);
  assert.equal(out.sent, 0);
});

const noSleep = async () => {};
const mk = (codes) => ({
  claim: async () => true, release: async () => {}, sleep: noSleep,
  send: async (r) => ({ statusCode: codes[r.email] ?? 200 }),
});

test('two rejects in a row halt the run (our payload, not the recipients)', async () => {
  const rows = ['a', 'b', 'c'].map((n) => row(`${n}@real.org`));
  const out = await w.sendWelcomes(rows, mk({ 'a@real.org': 422, 'b@real.org': 422 }));
  assert.equal(out.rejected, 2);
  assert.equal(out.halted, true);
});

test('a success between rejects resets the streak but rejected stays non-zero', async () => {
  const rows = ['a', 'b', 'c'].map((n) => row(`${n}@real.org`));
  const out = await w.sendWelcomes(rows, mk({ 'a@real.org': 422, 'c@real.org': 400 }));
  assert.equal(out.halted, false);
  assert.equal(out.rejected, 2);
  assert.equal(out.sent, 1);
});

test('a release that throws still halts and does not escape', async () => {
  const m = mk({ 'a@real.org': 503 });
  m.release = async () => { throw new Error('db down'); };
  const out = await w.sendWelcomes([row('a@real.org')], m);
  assert.equal(out.halted, true);
});

test('stale and probe rows are stamped, never sent', async () => {
  const now = Date.parse('2026-11-20T00:00:00Z');
  const claimed = [], sent = [];
  const rows = [
    row('old@real.org', { created_at: '2026-10-01T00:00:00Z' }),
    row('probe@example.com', { created_at: '2026-11-19T00:00:00Z' }),
    row('new@real.org', { created_at: '2026-11-19T00:00:00Z' }),
  ];
  const out = await w.sendWelcomes(rows, {
    now, sleep: noSleep,
    claim: async (e) => { claimed.push(e); return true; },
    release: async () => {},
    send: async (r) => { sent.push(r.email); return { statusCode: 200 }; },
  });
  assert.deepEqual(sent, ['new@real.org']);
  assert.equal(out.stamped, 2);
  assert.equal(out.skipped.stale, 1);
  assert.equal(out.skipped.probe, 1);
});

test('isProbeEmail boundaries', () => {
  assert.equal(w.isProbeEmail('x@example.com'), true);
  assert.equal(w.isProbeEmail('x@resend.dev'), true);
  assert.equal(w.isProbeEmail('x@examples.com'), false);
  assert.equal(w.isProbeEmail('person@gmail.com'), false);
});
