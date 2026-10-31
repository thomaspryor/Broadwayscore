// BRO-3712: one-tap Gmail renewal. require()s the real helpers and the real
// script (CLAUDE.md rule 15); only fetch is stubbed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const g = require('../../scripts/lib/gmail-reauth.js');
const { seal, open } = require('../../scripts/lib/hkdf-seal.js');
const { completeGrant, tokenStatus } = require('../../scripts/gmail-reauth.js');
const { extractDecisionQuestion } = require('../../scripts/lib/owner-decision-notify.js');

const SECRET = 'test-hmac-secret';
const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);

function linkParams(url) {
  const u = new URL(url);
  return { e: u.searchParams.get('e'), s: u.searchParams.get('s'), u };
}

test('a fresh start link verifies; expiry, tampering and a wrong key do not', () => {
  const { url, exp } = g.buildStartLink(SECRET, NOW);
  const { e, s, u } = linkParams(url);
  assert.equal(u.origin + u.pathname, `${g.SITE_ORIGIN}${g.START_PATH}`);
  assert.equal(Number(e), exp);
  assert.equal(exp, Math.floor(NOW / 1000) + g.LINK_TTL_DAYS * 86400);
  assert.deepEqual(g.verifyStartLink(e, s, SECRET, NOW), { ok: true });
  assert.equal(g.verifyStartLink(e, s, SECRET, exp * 1000 + 1).reason, 'expired');
  assert.equal(g.verifyStartLink(String(exp + 86400), s, SECRET, NOW).reason, 'bad-signature');
  const flipped = (s[0] === 'a' ? 'b' : 'a') + s.slice(1);
  assert.equal(g.verifyStartLink(e, flipped, SECRET, NOW).reason, 'bad-signature');
  assert.equal(g.verifyStartLink(e, s.slice(0, -1), SECRET, NOW).reason, 'bad-signature');
  assert.equal(g.verifyStartLink(e, s, 'other-secret', NOW).reason, 'bad-signature');
  assert.equal(g.verifyStartLink(e, s, undefined, NOW).reason, 'no-secret');
  assert.equal(g.verifyStartLink(null, s, SECRET, NOW).reason, 'malformed');
  assert.equal(g.verifyStartLink(e, 'XYZ', SECRET, NOW).reason, 'malformed');
  assert.equal(g.verifyStartLink(`${e}&x`, s, SECRET, NOW).reason, 'malformed');
});

test('the consent URL asks only for gmail.readonly, offline, fresh consent, PKCE S256, owner hint', () => {
  const req = g.makeAuthRequest();
  const u = new URL(g.buildConsentUrl({ clientId: 'cid.apps.googleusercontent.com', state: req.state, challenge: req.challenge }));
  assert.equal(u.origin + u.pathname, g.GOOGLE_AUTH_URL);
  const p = Object.fromEntries(u.searchParams);
  assert.deepEqual(p, {
    client_id: 'cid.apps.googleusercontent.com',
    redirect_uri: 'https://broadwayscorecard.com/api/admin/gmail-reauth/callback',
    response_type: 'code',
    scope: 'https://www.googleapis.com/auth/gmail.readonly',
    access_type: 'offline',
    prompt: 'consent',
    login_hint: g.OWNER_ACCOUNT,
    state: req.state,
    code_challenge: req.challenge,
    code_challenge_method: 'S256',
  });
  assert.throws(() => g.buildConsentUrl({ clientId: '', state: 'x', challenge: 'y' }));
});

test('state + verifier survive the cookie; junk and mismatched states are refused', () => {
  const req = g.makeAuthRequest();
  assert.notEqual(req.state, g.makeAuthRequest().state);
  assert.deepEqual(g.parseCookieValue(g.cookieValue(req)), { state: req.state, verifier: req.verifier });
  for (const bad of [undefined, '', 'nodot', 'a.b', `${req.state}.${req.verifier};x`, `${req.state}.short`]) {
    assert.equal(g.parseCookieValue(bad), null, String(bad));
  }
  assert.equal(g.statesMatch(req.state, req.state), true);
  assert.equal(g.statesMatch(req.state.slice(1) + 'A', req.state), false);
  assert.equal(g.statesMatch('', ''), false);
  assert.equal(g.statesMatch(null, req.state), false);
});

test('scope and owner checks', () => {
  assert.equal(g.grantedScopeOk('email https://www.googleapis.com/auth/gmail.readonly'), true);
  assert.equal(g.grantedScopeOk('https://www.googleapis.com/auth/gmail.metadata'), false);
  assert.equal(g.grantedScopeOk(null), false);
  assert.equal(g.isOwnerAccount(' Thomas.Pryor@Gmail.com '), true);
  assert.equal(g.isOwnerAccount('someone@gmail.com'), false);
  assert.equal(g.isOwnerAccount(undefined), false);
});

test('a sealed grant opens only with the key, untampered, and within 10 minutes', () => {
  const token = g.sealGrant({ code: '4/abc', verifier: 'v'.repeat(64) }, SECRET, NOW);
  assert.ok(token.startsWith('g1.'));
  assert.ok(!token.includes('4/abc'));
  assert.deepEqual(g.openGrant(token, SECRET, NOW + 60_000), { code: '4/abc', verifier: 'v'.repeat(64) });
  assert.deepEqual(g.openGrant(token, SECRET, NOW + g.GRANT_MAX_AGE_MS + 1), { error: 'expired' });
  assert.deepEqual(g.openGrant(token, SECRET, NOW - 120_000), { error: 'expired' });
  assert.deepEqual(g.openGrant(token, 'other', NOW), { error: 'unreadable' });
  const raw = Buffer.from(token.slice(3), 'base64url');
  raw[raw.length - 1] ^= 1;
  assert.deepEqual(g.openGrant(`g1.${raw.toString('base64url')}`, SECRET, NOW), { error: 'unreadable' });
  assert.deepEqual(g.openGrant('', SECRET, NOW), { error: 'unreadable' });
  // A submitter-contact token (same secret, other HKDF info) is not a grant.
  const foreign = seal('{"code":"x","verifier":"y","iat":0}', SECRET, { info: 'other', prefix: 'g1.' });
  assert.deepEqual(g.openGrant(foreign, SECRET, NOW), { error: 'unreadable' });
  assert.throws(() => g.sealGrant({ code: '', verifier: 'v' }, SECRET));
  assert.throws(() => g.sealGrant({ code: 'c', verifier: 'v' }, ''));
});

test('hkdf-seal round-trips and keys each use separately', () => {
  const opts = { info: 'a', prefix: 'p.' };
  const t = seal('hello', SECRET, opts);
  assert.equal(open(t, SECRET, opts), 'hello');
  assert.equal(open(t, SECRET, { info: 'b', prefix: 'p.' }), null);
  assert.equal(open(t, SECRET, { info: 'a', prefix: 'q.' }), null);
  assert.equal(open(t, '', opts), null);
  assert.notEqual(seal('hello', SECRET, opts), t, 'fresh IV per seal');
});

test('classifyAuthProbe reads Google error pages and the sign-in redirect', () => {
  const errLoc = (name) => `https://accounts.google.com/signin/oauth/error?authError=${Buffer.from(`\n\x15${name}\x12\x10detail`, 'latin1').toString('base64')}&client_id=x`;
  assert.deepEqual(g.classifyAuthProbe({ status: 302, location: errLoc('redirect_uri_mismatch') }), { ok: false, error: 'redirect_uri_mismatch' });
  assert.deepEqual(g.classifyAuthProbe({ status: 302, location: errLoc('invalid_client') }), { ok: false, error: 'invalid_client' });
  assert.deepEqual(g.classifyAuthProbe({ status: 302, location: 'https://accounts.google.com/v3/signin/identifier?opparams=x' }), { ok: true, error: null });
  assert.equal(g.classifyAuthProbe({ status: 302, location: 'https://evil.example/x' }).ok, false);
  assert.equal(g.classifyAuthProbe({ status: 200, location: null }).error, 'unexpected-response-200');
  assert.equal(g.classifyAuthProbe({ status: 400, location: 'https://accounts.google.com/x' }).ok, false);
});

test('the card block fits the email cap, replaces itself, and strips cleanly', () => {
  const { url, exp } = g.buildStartLink(SECRET, NOW);
  const block = g.decisionBlock({ url, exp });
  const [first, second] = block.split('\n');
  assert.ok(first.startsWith('DECISION NEEDED: '));
  assert.ok(first.includes(url));
  assert.ok(second.includes('2026-11-11'));
  // The owner's email quotes the first DECISION NEEDED line (capped); the link
  // must reach it whole, even with the longest failure reason in front.
  const longest = 'Gmail reconnect did not finish: It was approved with a different Google account than thomas.pryor@gmail.com.';
  const setup = g.decisionBlock({ url, exp, setup: true });
  assert.match(setup.split('\n')[0], /one setup step/);
  for (const b of [block, setup, g.decisionBlock({ url, exp, problem: longest })]) {
    const card = g.withDecisionBlock('Card body.', b);
    const q = extractDecisionQuestion(card);
    assert.ok(q && q.includes(url), `emailed question lost the link: ${q}`);
    // What Linear stores: bare URLs and addresses autolinked (BRO-5235).
    const stored = card.replace(/https:\/\/\S+?(?=[\s)]|$)/g, (u) => `[${u}](<${u}>)`).replace(/thomas\.pryor@gmail\.com/g, (a) => `[${a}](<mailto:${a}>)`);
    assert.equal(extractDecisionQuestion(stored), q, 'Linear form emails the same line');
  }

  const original = 'Problem: token revoked.\n\nDECISION NEEDED: something else entirely';
  const once = g.withDecisionBlock(original, block);
  assert.ok(once.startsWith(first));
  const twice = g.withDecisionBlock(once, g.decisionBlock(g.buildStartLink(SECRET, NOW + 1000)));
  assert.equal(twice.split('\n').filter((l) => l.includes(g.START_PATH)).length, 1, 'no stacked links');
  assert.equal(g.stripDecisionBlock(once), original, 'other content, including another decision, kept');
  assert.equal(g.withDecisionBlock(null, block), block);
  assert.equal(g.existingLinkExp(once), exp);
  // A design note quoting the bare path is not this flow's line.
  const note = 'Route: GET /api/admin/gmail-reauth?e=<exp>&s=<sig>';
  assert.equal(g.stripDecisionBlock(note), note);
  assert.equal(g.existingLinkExp(note), null);
});

// main() link mode against a stubbed Linear client (require cache) and a
// stubbed Google answer; the real writeLink/probe code runs.
async function runLink({ description = 'Card body.', googleLocation, argv = [] }) {
  const linearPath = require.resolve('../../scripts/lib/linear-client.js');
  const saved = require.cache[linearPath];
  const updates = [];
  require.cache[linearPath] = { id: linearPath, filename: linearPath, loaded: true, exports: {
    graphql: async () => ({ issue: { id: 'i1', description, state: { type: 'started' } } }),
    updateIssue: async (id, input) => { updates.push(input); },
    getTeam: async () => ({ states: { nodes: [] } }),
  } };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 302, headers: { location: googleLocation } });
  const envSaved = { ...process.env };
  Object.assign(process.env, { GMAIL_CLIENT_ID: '123-abc.apps.googleusercontent.com', APPROVAL_HMAC_SECRET: SECRET });
  try {
    const { main } = require('../../scripts/gmail-reauth.js');
    const code = await main(['link', '--issue=BRO-1', ...argv]);
    return { code, updates };
  } finally {
    globalThis.fetch = realFetch;
    process.env = envSaved;
    if (saved) require.cache[linearPath] = saved; else delete require.cache[linearPath];
  }
}

const SIGN_IN = 'https://accounts.google.com/v3/signin/identifier?x=1';
const authError = (name) => `https://accounts.google.com/signin/oauth/error?authError=${Buffer.from(`\n\x15${name}\x12`, 'latin1').toString('base64')}`;

test('link mode: writes a link, keeps a fresh one, re-mints near expiry or with a reason', async () => {
  const first = await runLink({ googleLocation: SIGN_IN });
  assert.equal(first.code, 0);
  assert.equal(first.updates.length, 1);
  const desc = first.updates[0].description;
  assert.ok(g.existingLinkExp(desc));

  const again = await runLink({ description: desc, googleLocation: SIGN_IN });
  assert.equal(again.updates.length, 0, 'a link with weeks left is kept, so no second email');

  const reason = await runLink({ description: desc, googleLocation: SIGN_IN, argv: ['--problem=Gmail reconnect did not finish.'] });
  assert.equal(reason.updates.length, 1, 'a failure reason always re-posts');
  assert.match(reason.updates[0].description.split('\n')[0], /\(Gmail reconnect did not finish\.\)$/);

  const { url } = g.buildStartLink(SECRET, Date.now() - 25 * 86400 * 1000);
  const old = await runLink({ description: `DECISION NEEDED: Tap ${url} and press Allow.`, googleLocation: SIGN_IN });
  assert.equal(old.updates.length, 1, 'a link with under a week left is replaced');
});

test('link mode: setup variant on redirect_uri_mismatch, no link on a client error, a link on an odd answer', async () => {
  const setup = await runLink({ googleLocation: authError('redirect_uri_mismatch') });
  assert.equal(setup.code, 0);
  assert.match(setup.updates[0].description, /one setup step/);
  const bad = await runLink({ googleLocation: authError('invalid_client') });
  assert.equal(bad.code, 1);
  assert.equal(bad.updates.length, 0);
  const odd = await runLink({ googleLocation: 'https://consent.example.com/interstitial' });
  assert.equal(odd.code, 0);
  assert.equal(odd.updates.length, 1);
});

function stubFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url: String(url), init });
    const r = routes[String(url)];
    if (!r) throw new Error(`unexpected fetch ${url}`);
    return new Response(JSON.stringify(r.body), { status: r.status || 200 });
  };
  return { fn, calls };
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const PROFILE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';

function env(nowMs = NOW) {
  return {
    GMAIL_CLIENT_ID: 'cid',
    GMAIL_CLIENT_SECRET: 'csecret',
    APPROVAL_HMAC_SECRET: SECRET,
    GMAIL_REAUTH_SEALED: g.sealGrant({ code: '4/code', verifier: 'v'.repeat(64) }, SECRET, nowMs),
  };
}

const goodToken = { access_token: 'ya29.x', refresh_token: '1//r', scope: g.SCOPE, token_type: 'Bearer' };

test('completeGrant: owner approval yields the refresh token, sent with PKCE + redirect_uri', async () => {
  const { fn, calls } = stubFetch({
    [TOKEN_URL]: { body: goodToken },
    [PROFILE_URL]: { body: { emailAddress: 'thomas.pryor@gmail.com' } },
  });
  const res = await completeGrant(env(), fn, NOW + 30_000);
  assert.deepEqual(res, { ok: true, refreshToken: '1//r' });
  const body = new URLSearchParams(calls[0].init.body);
  assert.equal(body.get('code'), '4/code');
  assert.equal(body.get('code_verifier'), 'v'.repeat(64));
  assert.equal(body.get('redirect_uri'), g.REDIRECT_URI);
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(calls[1].init.headers.Authorization, 'Bearer ya29.x');
});

test('completeGrant refuses another account, a missing refresh token, a narrowed scope, a refused code, a stale grant', async () => {
  const other = stubFetch({ [TOKEN_URL]: { body: goodToken }, [PROFILE_URL]: { body: { emailAddress: 'intruder@gmail.com' } } });
  const r1 = await completeGrant(env(), other.fn, NOW);
  assert.equal(r1.ok, false);
  assert.match(r1.reason, /different Google account/);

  const noRefresh = stubFetch({ [TOKEN_URL]: { body: { access_token: 'ya29.x', scope: g.SCOPE } } });
  assert.match((await completeGrant(env(), noRefresh.fn, NOW)).reason, /long-lived key/);

  const narrow = stubFetch({ [TOKEN_URL]: { body: { ...goodToken, scope: 'email' } } });
  assert.match((await completeGrant(env(), narrow.fn, NOW)).reason, /Gmail read access/);

  const refused = stubFetch({ [TOKEN_URL]: { status: 400, body: { error: 'invalid_grant' } } });
  assert.match((await completeGrant(env(), refused.fn, NOW)).reason, /did not accept/);

  const never = stubFetch({});
  assert.match((await completeGrant(env(NOW - g.GRANT_MAX_AGE_MS - 1), never.fn, NOW)).reason, /too long/);
  assert.match((await completeGrant({ ...env(), GMAIL_REAUTH_SEALED: 'g1.junk' }, never.fn, NOW)).reason, /could not be read/);
  assert.equal(never.calls.length, 0, 'no network call for an unreadable or stale grant');
});

test('tokenStatus: only invalid_grant (or no token) counts as revoked; outages are unknown', async () => {
  const base = { GMAIL_CLIENT_ID: 'cid', GMAIL_CLIENT_SECRET: 's', GMAIL_REFRESH_TOKEN: '1//r' };
  const ok = stubFetch({ [TOKEN_URL]: { body: { access_token: 'ya29.x' } } });
  assert.equal(await tokenStatus(base, ok.fn), 'ok');
  const body = new URLSearchParams(ok.calls[0].init.body);
  assert.equal(body.get('grant_type'), 'refresh_token');
  assert.equal(body.get('refresh_token'), '1//r');
  assert.equal(await tokenStatus(base, stubFetch({ [TOKEN_URL]: { status: 400, body: { error: 'invalid_grant' } } }).fn), 'revoked');
  assert.equal(await tokenStatus(base, stubFetch({ [TOKEN_URL]: { status: 401, body: { error: 'invalid_client' } } }).fn), 'unknown');
  assert.equal(await tokenStatus(base, stubFetch({ [TOKEN_URL]: { status: 503, body: {} } }).fn), 'unknown');
  assert.equal(await tokenStatus({ ...base, GMAIL_REFRESH_TOKEN: '' }, stubFetch({}).fn), 'revoked');
});

test('consoleClientUrl opens this client in its own project; odd ids fall back to the credentials list', () => {
  assert.equal(g.consoleClientUrl('1234567890123-abc123.apps.googleusercontent.com'),
    'https://console.cloud.google.com/apis/credentials/oauthclient/1234567890123-abc123.apps.googleusercontent.com?project=1234567890123');
  assert.equal(g.consoleClientUrl('weird'), 'https://console.cloud.google.com/apis/credentials');
  assert.equal(g.consoleClientUrl(undefined), 'https://console.cloud.google.com/apis/credentials');
});

test('probeConsent gives up on a hung Google instead of running out the route clock', async () => {
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  const t0 = Date.now();
  const keepAlive = setTimeout(() => {}, 3000); // AbortSignal.timeout's timer is unref'd
  try {
    await assert.rejects(g.probeConsent('cid', hang, 50), /TimeoutError|timed out|aborted/i);
  } finally { clearTimeout(keepAlive); }
  assert.ok(Date.now() - t0 < 2000);
});
