/**
 * BRO-3712: the real /api/admin/gmail-reauth start + callback handlers.
 * Start: only a signed, unexpired link reaches Google, with a locked-down
 * state cookie. Callback: only a state matching that cookie dispatches, and
 * the dispatch carries a sealed grant, never the raw code or verifier.
 *
 * Only global fetch is stubbed. Run: npx tsx --test src/app/api/__tests__/gmail-reauth-route.test.mjs
 */
import { register, createRequire } from 'node:module';
register('./next-subpath-loader.mjs', import.meta.url);

import { test } from 'node:test';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const g = require('../../../../scripts/lib/gmail-reauth.js');

const SECRET = 'route-test-secret';
process.env.APPROVAL_HMAC_SECRET = SECRET;
process.env.GMAIL_CLIENT_ID = 'cid.apps.googleusercontent.com';
process.env.GH_DISPATCH_TOKEN = 'test-dispatch';
const realFetch = globalThis.fetch;

const SIGN_IN = 'https://accounts.google.com/v3/signin/identifier?x=1';
const MISMATCH = `https://accounts.google.com/signin/oauth/error?authError=${Buffer.from('\n\x15redirect_uri_mismatch\x12', 'latin1').toString('base64')}`;

// The start route asks Google first; stub that answer (never the real network).
async function start(query, googleSays = SIGN_IN) {
  const probes = [];
  globalThis.fetch = async (url) => {
    probes.push(String(url));
    if (!String(url).startsWith(g.GOOGLE_AUTH_URL)) throw new Error(`unexpected fetch ${url}`);
    return new Response(null, { status: 302, headers: { location: googleSays } });
  };
  try {
    const { GET } = await import('../admin/gmail-reauth/route.ts');
    const { NextRequest } = await import('next/server');
    const res = await GET(new NextRequest(`https://broadwayscorecard.com/api/admin/gmail-reauth${query}`));
    res.probes = probes;
    return res;
  } finally {
    globalThis.fetch = realFetch;
  }
}

async function callback(query, cookie) {
  const { GET } = await import('../admin/gmail-reauth/callback/route.ts');
  const { NextRequest } = await import('next/server');
  const headers = cookie ? { cookie: `${g.COOKIE_NAME}=${cookie}` } : {};
  return GET(new NextRequest(`https://broadwayscorecard.com/api/admin/gmail-reauth/callback${query}`, { headers }));
}

function signedQuery(nowMs = Date.now()) {
  const u = new URL(g.buildStartLink(SECRET, nowMs).url);
  return u.search;
}

test('a signed link 302s to Google consent and sets a scoped HttpOnly state cookie', async () => {
  const res = await start(signedQuery());
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, g.GOOGLE_AUTH_URL);
  assert.equal(loc.searchParams.get('client_id'), 'cid.apps.googleusercontent.com');
  assert.equal(loc.searchParams.get('scope'), g.SCOPE);
  const cookie = res.headers.get('set-cookie');
  for (const part of ['HttpOnly', 'Secure', 'SameSite=Lax', `Path=${g.START_PATH}`, `Max-Age=${g.COOKIE_MAX_AGE_S}`]) {
    assert.ok(cookie.includes(part), `cookie lacks ${part}`);
  }
  const value = cookie.split(';')[0].split('=').slice(1).join('=');
  assert.equal(g.parseCookieValue(value).state, loc.searchParams.get('state'));
});

test('unsigned, tampered and expired links never reach Google', async () => {
  for (const [q, status] of [
    ['', 403],
    [signedQuery().replace(/s=([0-9a-f])/, (m, c) => `s=${c === 'a' ? 'b' : 'a'}`), 403],
    [signedQuery(Date.now() - 31 * 86400 * 1000), 410],
  ]) {
    const res = await start(q);
    assert.equal(res.status, status, q);
    assert.equal(res.headers.get('location'), null);
    assert.equal(res.headers.get('set-cookie'), null);
    assert.equal(res.probes.length, 0, 'an unverified link never calls Google');
  }
});

test('when Google does not accept the callback yet, the link shows the one-time setup step', async () => {
  const q = signedQuery();
  const res = await start(`${q}&x=%22%3E%3Cscript%3E`, MISMATCH);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('set-cookie'), null, 'no flow starts until Google accepts');
  const html = await res.text();
  assert.match(html, /One-Time Setup/);
  assert.ok(html.includes(`value="${g.REDIRECT_URI}"`));
  assert.ok(html.includes(g.consoleClientUrl('cid.apps.googleusercontent.com').replace(/&/g, '&amp;')));
  assert.ok(html.includes(`href="${g.SITE_ORIGIN}${g.START_PATH}${q.replace('&', '&amp;')}"`), 'Continue re-opens the same signed link');
  assert.ok(!html.includes('<script>'), 'extra query params are not echoed');
});

test('a Google outage during the check still goes on to Google', async () => {
  globalThis.fetch = async () => { throw new Error('network down'); };
  try {
    const { GET } = await import('../admin/gmail-reauth/route.ts');
    const { NextRequest } = await import('next/server');
    const res = await GET(new NextRequest(`https://broadwayscorecard.com/api/admin/gmail-reauth${signedQuery()}`));
    assert.equal(res.status, 302);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the kill switch hides both routes', async () => {
  process.env.GMAIL_REAUTH_DISABLED = 'true';
  try {
    assert.equal((await start(signedQuery())).status, 404);
    assert.equal((await callback('?code=x&state=y')).status, 404);
  } finally {
    delete process.env.GMAIL_REAUTH_DISABLED;
  }
});

async function startedFlow() {
  const res = await start(signedQuery());
  const cookie = res.headers.get('set-cookie').split(';')[0].split('=').slice(1).join('=');
  return { cookie, ...g.parseCookieValue(cookie) };
}

test('callback with a matching state dispatches gmail-reauth.yml with a sealed grant only', async () => {
  const flow = await startedFlow();
  let dispatched = null;
  globalThis.fetch = async (url, init) => {
    dispatched = { url: String(url), init };
    return new Response(null, { status: 204 });
  };
  try {
    const q = `?state=${flow.state}&code=4%2Fsecret-code&scope=${encodeURIComponent(g.SCOPE)}`;
    const res = await callback(q, flow.cookie);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('set-cookie'), /Max-Age=0/);
    assert.match(dispatched.url, /actions\/workflows\/gmail-reauth\.yml\/dispatches$/);
    assert.equal(dispatched.init.headers.Authorization, 'Bearer test-dispatch');
    const body = JSON.parse(dispatched.init.body);
    assert.equal(body.ref, 'main');
    assert.equal(body.inputs.mode, 'complete');
    assert.ok(!dispatched.init.body.includes('secret-code'), 'raw code is not in the public dispatch');
    assert.ok(!dispatched.init.body.includes(flow.verifier), 'verifier is not in the public dispatch');
    assert.deepEqual(g.openGrant(body.inputs.sealed, SECRET), { code: '4/secret-code', verifier: flow.verifier });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('callback refuses a missing cookie, a mismatched state, a denial and a narrowed scope without dispatching', async () => {
  const flow = await startedFlow();
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response(null, { status: 204 }); };
  try {
    const scope = encodeURIComponent(g.SCOPE);
    assert.equal((await callback(`?state=${flow.state}&code=c&scope=${scope}`)).status, 400);
    assert.equal((await callback(`?state=${flow.state}x&code=c&scope=${scope}`, flow.cookie)).status, 400);
    assert.equal((await callback(`?state=${flow.state}&error=access_denied`, flow.cookie)).status, 200);
    assert.equal((await callback(`?state=${flow.state}&scope=${scope}`, flow.cookie)).status, 400);
    assert.equal((await callback(`?state=${flow.state}&code=c&scope=email`, flow.cookie)).status, 200);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a failed dispatch tells the owner to retry', async () => {
  const flow = await startedFlow();
  globalThis.fetch = async () => new Response('{}', { status: 401 });
  try {
    const res = await callback(`?state=${flow.state}&code=c&scope=${encodeURIComponent(g.SCOPE)}`, flow.cookie);
    assert.equal(res.status, 502);
    assert.match(await res.text(), /tap the link again/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
