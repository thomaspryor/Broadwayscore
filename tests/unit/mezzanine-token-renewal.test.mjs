// BRO-5235: Mezzanine session-token renewal. require()s the real helpers and
// the real script (CLAUDE.md rule 15); only fetch and the Parse query are stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const m = require('../../scripts/lib/mezzanine-token-renewal.js');
const gmail = require('../../scripts/lib/gmail-reauth.js');
const { checkSession, completeToken, main } = require('../../scripts/mezzanine-token.js');
const { extractDecisionQuestion } = require('../../scripts/lib/owner-decision-notify.js');

const SECRET = 'test-hmac-secret';
const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);
const TOKEN = 'r:0123456789abcdef0123456789abcdef';
const DAY = 86400 * 1000;

function params(url) {
  const u = new URL(url);
  return [u.searchParams.get('e'), u.searchParams.get('s')];
}

function parseReply(status, body) {
  return async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}

test('signed link verifies; forged, expired and Gmail links do not', () => {
  const { url } = m.buildStartLink(SECRET, NOW);
  assert.ok(url.startsWith('https://broadwayscorecard.com/api/admin/mezzanine-token?e='));
  const [e, s] = params(url);
  assert.deepEqual(m.verifyStartLink(e, s, SECRET, NOW), { ok: true });
  assert.equal(m.verifyStartLink(e, s.replace(/^./, (c) => (c === 'a' ? 'b' : 'a')), SECRET, NOW).reason, 'bad-signature');
  assert.equal(m.verifyStartLink(e, s, 'other-secret', NOW).reason, 'bad-signature');
  assert.equal(m.verifyStartLink(e, s, SECRET, NOW + 31 * DAY).reason, 'expired');
  assert.equal(m.verifyStartLink(e, s, undefined, NOW).reason, 'no-secret');
  assert.equal(m.verifyStartLink('abc', s, SECRET, NOW).reason, 'malformed');
  const [ge, gs] = params(gmail.buildStartLink(SECRET, NOW).url);
  assert.equal(m.verifyStartLink(ge, gs, SECRET, NOW).reason, 'bad-signature');
  assert.equal(gmail.verifyStartLink(e, s, SECRET, NOW).reason, 'bad-signature');
});

test('extractToken finds the token in a bare value, a header line or a whole request', () => {
  assert.equal(m.extractToken(TOKEN), TOKEN);
  assert.equal(m.extractToken(`  ${TOKEN}\n`), TOKEN);
  assert.equal(m.extractToken(`X-Parse-Session-Token: ${TOKEN}`), TOKEN);
  assert.equal(m.extractToken(`curl 'https://api.theaterdiary.com/parse/classes/Show' -H 'x-parse-session-token: ${TOKEN}' -H 'X-Parse-Application-Id: abc'`), TOKEN);
  assert.equal(m.extractToken(`{"X-Parse-Session-Token":"${TOKEN}"}`), TOKEN);
  assert.equal(m.extractToken('X-Parse-Session-Token: abcdefghij0123456789AB'), 'abcdefghij0123456789AB');
  assert.equal(m.extractToken(`objectId r:${'f'.repeat(32)} later`), `r:${'f'.repeat(32)}`);
  for (const bad of ['', '   ', 'hello there', 'r:short', 'X-Parse-Application-Id: abc', null, undefined]) {
    assert.equal(m.extractToken(bad), null, String(bad));
  }
});

test('isSameOriginPost: our origin, or a null origin with same-origin fetch metadata', () => {
  assert.equal(m.isSameOriginPost({ origin: 'https://broadwayscorecard.com', secFetchSite: null }), true);
  assert.equal(m.isSameOriginPost({ origin: 'https://evil.example', secFetchSite: 'same-origin' }), false);
  assert.equal(m.isSameOriginPost({ origin: 'https://broadwayscorecard.com.evil.example', secFetchSite: null }), false);
  assert.equal(m.isSameOriginPost({ origin: 'null', secFetchSite: 'same-origin' }), true);
  assert.equal(m.isSameOriginPost({ origin: 'null', secFetchSite: 'cross-site' }), false);
  assert.equal(m.isSameOriginPost({ origin: null, secFetchSite: null }), false);
});

test('sealed token round-trips, and tampered, wrong-secret or stale seals do not open', () => {
  const sealed = m.sealToken(TOKEN, SECRET, NOW);
  assert.ok(!sealed.includes(TOKEN.slice(2)));
  assert.deepEqual(m.openToken(sealed, SECRET, NOW + 1000), { token: TOKEN });
  assert.equal(m.openToken(sealed, 'other', NOW).error, 'unreadable');
  const flipped = sealed.slice(0, -2) + (sealed.slice(-2, -1) === 'A' ? 'B' : 'A') + sealed.slice(-1);
  assert.equal(m.openToken(flipped, SECRET, NOW).error, 'unreadable');
  assert.equal(m.openToken(sealed, SECRET, NOW + m.SEALED_MAX_AGE_MS + 1).error, 'expired');
  assert.equal(m.openToken('', SECRET, NOW).error, 'unreadable');
  const gmailSealed = gmail.sealGrant({ code: 'c', verifier: 'v' }, SECRET, NOW);
  assert.equal(m.openToken(gmailSealed, SECRET, NOW).error, 'unreadable');
});

test('classifySession and expiryAction', () => {
  const ok = m.classifySession(200, JSON.stringify({ objectId: 'S1', sessionToken: TOKEN, expiresAt: { __type: 'Date', iso: '2026-11-01T00:00:00.000Z' }, user: { objectId: 'U1' } }));
  assert.deepEqual(ok, { state: 'ok', expiresAtMs: Date.UTC(2026, 10, 1), userId: 'U1' });
  assert.equal(m.classifySession(400, JSON.stringify({ code: 209, error: 'Invalid session token' })).state, 'expired');
  assert.equal(m.classifySession(404, 'Cannot GET').state, 'unknown');
  assert.equal(m.classifySession(502, '').state, 'unknown');
  assert.equal(m.classifySession(200, '{}').state, 'unknown');

  assert.equal(m.expiryAction(ok, Date.UTC(2026, 9, 13)), 'warn');
  assert.equal(m.expiryAction(ok, Date.UTC(2026, 8, 1)), 'none');
  assert.equal(m.expiryAction(ok, Date.UTC(2026, 10, 2)), 'expired');
  assert.equal(m.expiryAction({ state: 'expired' }, NOW), 'expired');
  assert.equal(m.expiryAction({ state: 'unknown' }, NOW), 'none');
  assert.equal(m.expiryAction({ state: 'ok', expiresAtMs: null }, NOW), 'none');
});

test('decision block: emailed line carries the link, and re-minting replaces it', () => {
  const { url, exp } = m.buildStartLink(SECRET, NOW);
  const b = m.decisionBlock({ url, exp, problem: 'The Mezzanine sign-in code has expired, so ratings are paused.' });
  assert.ok(!/—/.test(b), 'no em dashes in owner copy');
  const card = m.LINK.withDecisionBlock('Findings.\n\nMore.', b);
  const q = extractDecisionQuestion(card);
  // What Linear stores: every bare URL autolinked as [url](<url>).
  const stored = card.replace(/https:\/\/\S+?(?=[\s)]|$)/g, (u) => `[${u}](<${u}>)`);
  assert.equal(extractDecisionQuestion(stored), q, "Linear's autolinked form emails the same line");
  assert.equal(m.LINK.existingLinkExp(stored), exp);
  assert.ok(q && q.includes(url), `emailed question lost the link: ${q}`);
  assert.ok(!q.endsWith('…'), `emailed question was clipped (${q.length} chars)`);
  assert.ok(b.includes('ratings are paused'), 'the reason still reaches the card');
  assert.equal(m.LINK.existingLinkExp(card), exp);
  const next = m.buildStartLink(SECRET, NOW + DAY);
  const again = m.LINK.withDecisionBlock(card, m.decisionBlock(next));
  assert.equal((again.match(/DECISION NEEDED/g) || []).length, 1);
  assert.ok(!again.includes(url) && again.includes(next.url));
  assert.ok(again.endsWith('Findings.\n\nMore.'));
  assert.equal(m.LINK.stripDecisionBlock(again), 'Findings.\n\nMore.');
  // The Gmail flow's helpers leave this block alone and vice versa.
  assert.equal(gmail.LINK.stripDecisionBlock(again), again);
});

test('owner steps: one action per step, cleanup removes VPN and certificate', () => {
  for (const s of [...m.SETUP_STEPS, ...m.CAPTURE_STEPS, ...m.CLEANUP_STEPS]) {
    assert.ok(!/—/.test(s), s);
    assert.ok(!/<(script|a|img|iframe)\b/i.test(s), s);
  }
  const cleanup = m.CLEANUP_STEPS.join(' ');
  for (const w of ['VPN off', 'Certificate Trust Settings', 'Remove Profile']) assert.ok(cleanup.includes(w), w);
});

test('checkSession falls back to a query when sessions/me is missing', async () => {
  const okQuery = async () => ({ results: [] });
  const authFail = async () => { const e = new Error('209'); e.authFailed = true; throw e; };
  const down = async () => { throw new Error('ECONNRESET'); };
  assert.equal((await checkSession(TOKEN, 'app', { fetchImpl: parseReply(404, 'nope'), queryImpl: okQuery })).state, 'ok');
  assert.equal((await checkSession(TOKEN, 'app', { fetchImpl: parseReply(404, 'nope'), queryImpl: authFail })).state, 'expired');
  assert.equal((await checkSession(TOKEN, 'app', { fetchImpl: async () => { throw new TypeError('fetch failed'); }, queryImpl: down })).state, 'unknown');
  let queried = false;
  const r = await checkSession(TOKEN, 'app', { fetchImpl: parseReply(400, { code: 209, error: 'x' }), queryImpl: async () => { queried = true; } });
  assert.equal(r.state, 'expired');
  assert.equal(queried, false);
});

test('completeToken accepts a live token and refuses dead, foreign or stale ones', async () => {
  const sealed = m.sealToken(TOKEN, SECRET, NOW);
  const env = { MEZZANINE_TOKEN_SEALED: sealed, APPROVAL_HMAC_SECRET: SECRET, MEZZANINE_APP_ID: 'app' };
  const live = parseReply(200, { objectId: 'S', sessionToken: TOKEN, expiresAt: { iso: '2027-10-13T00:00:00Z' }, user: { objectId: 'U1' } });
  const ok = await completeToken(env, { fetchImpl: live }, NOW);
  assert.equal(ok.ok, true);
  assert.equal(ok.token, TOKEN);
  assert.equal(ok.userId, 'U1');

  assert.equal((await completeToken(env, { fetchImpl: parseReply(400, { code: 209, error: 'x' }) }, NOW)).ok, false);
  assert.equal((await completeToken({ ...env, MEZZANINE_OWNER_USER_ID: 'U2' }, { fetchImpl: live }, NOW)).ok, false);
  assert.equal((await completeToken({ ...env, MEZZANINE_OWNER_USER_ID: 'U1' }, { fetchImpl: live }, NOW)).ok, true);
  assert.equal((await completeToken(env, { fetchImpl: live }, NOW + 2 * m.SEALED_MAX_AGE_MS)).ok, false);
  assert.equal((await completeToken({ ...env, APPROVAL_HMAC_SECRET: 'x' }, { fetchImpl: live }, NOW)).ok, false);
  const past = parseReply(200, { objectId: 'S', sessionToken: TOKEN, expiresAt: '2026-01-01T00:00:00Z' });
  assert.equal((await completeToken(env, { fetchImpl: past }, NOW)).ok, false);
  const down = await completeToken(env, { fetchImpl: parseReply(503, ''), queryImpl: async () => { throw new Error('down'); } }, NOW);
  assert.equal(down.ok, true, 'Parse outage still saves; the re-run is the real test');
  // The 30-day warning's own (still live) token pasted again is refused.
  const soon = parseReply(200, { objectId: 'S', sessionToken: TOKEN, expiresAt: new Date(NOW + 10 * DAY).toISOString(), user: { objectId: 'U1' } });
  const old = await completeToken(env, { fetchImpl: soon }, NOW);
  assert.equal(old.ok, false);
  assert.match(old.reason, /Sign out of Mezzanine/);
  // A pinned owner is never bypassed when Parse cannot say whose token it is.
  const pinnedDown = await completeToken({ ...env, MEZZANINE_OWNER_USER_ID: 'U1' }, { fetchImpl: parseReply(404, 'nope'), queryImpl: async () => ({ results: [] }) }, NOW);
  assert.equal(pinnedDown.ok, false);
  for (const r of [ok, down]) assert.ok(!JSON.stringify({ ...r, token: undefined }).includes(TOKEN.slice(2)));
});

test('main complete writes the token 0600 and prints no token', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mezz-'));
  const out = path.join(dir, 'tok');
  const saved = { ...process.env };
  Object.assign(process.env, { MEZZANINE_TOKEN_SEALED: m.sealToken(TOKEN, SECRET), APPROVAL_HMAC_SECRET: SECRET, MEZZANINE_APP_ID: 'app' });
  delete process.env.GITHUB_OUTPUT;
  const logs = [];
  const orig = [console.log, console.error];
  console.log = console.error = (...a) => logs.push(a.join(' '));
  try {
    const code = await main(['complete', `--out=${out}`], { fetchImpl: parseReply(200, { objectId: 'S', sessionToken: TOKEN, expiresAt: { iso: '2027-10-13T00:00:00Z' } }) });
    assert.equal(code, 0);
  } finally {
    [console.log, console.error] = orig;
    process.env = saved;
  }
  assert.equal(fs.readFileSync(out, 'utf8'), TOKEN);
  assert.equal(fs.statSync(out).mode & 0o777, 0o600);
  // In Actions the one ::add-mask:: line carries the token on purpose (the
  // runner hides it from every later line); nothing else may.
  const printed = logs.filter((l) => !l.startsWith('::add-mask::')).join('\n');
  assert.ok(!printed.includes(TOKEN.slice(2)), 'the token was printed');
  assert.ok(logs.join('\n').includes('expires 2027-10-13'));
});
