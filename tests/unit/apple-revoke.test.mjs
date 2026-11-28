// BRO-6290: account deletion must revoke the user's Sign in with Apple token
// (App Review Guideline 5.1.1(v)). Exercises the real edge-function code:
// supabase/functions/delete-account/apple-revoke.mjs (code exchange, then
// refresh_token revocation) and handler.mjs (deletion never waits on Apple's
// verdict), with fetch mocked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createPublicKey, verify } from 'node:crypto';

import {
  makeAppleClientSecret,
  revokeAppleAuthorization,
  APPLE_APP_CLIENT_ID,
  APPLE_KEY_ID,
  APPLE_TEAM_ID,
} from '../../supabase/functions/delete-account/apple-revoke.mjs';
import { handleDeleteAccount } from '../../supabase/functions/delete-account/handler.mjs';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });
const PUBLIC = createPublicKey(privateKey);

function jsonRes(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const APPLE_SUB = '001234.abcdef.0001';
const idToken = (sub) => `h.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.s`;

function decodeJwt(jwt) {
  const [h, p, s] = jwt.split('.');
  const parse = (x) => JSON.parse(Buffer.from(x, 'base64url').toString('utf8'));
  return { header: parse(h), payload: parse(p), input: `${h}.${p}`, sig: Buffer.from(s, 'base64url') };
}

/** Records Apple calls; `apple` maps path -> Response factory. */
function appleFetch(apple) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    const params = Object.fromEntries(new URLSearchParams(init.body || ''));
    calls.push({ path: u.pathname, host: u.host, params });
    const make = apple[u.pathname];
    if (!make) throw new Error(`unexpected Apple call ${url}`);
    return make(params);
  };
  return { fn, calls };
}

test('client secret is a valid ES256 JWT for the app bundle id', async () => {
  const jwt = await makeAppleClientSecret({ privateKeyPem: PEM, now: 1_800_000_000 });
  const { header, payload, input, sig } = decodeJwt(jwt);
  assert.deepEqual(header, { alg: 'ES256', kid: APPLE_KEY_ID, typ: 'JWT' });
  assert.deepEqual(payload, {
    iss: APPLE_TEAM_ID,
    iat: 1_800_000_000,
    exp: 1_800_000_300,
    aud: 'https://appleid.apple.com',
    sub: 'com.broadwayscorecard.app',
  });
  assert.equal(APPLE_APP_CLIENT_ID, 'com.broadwayscorecard.app');
  assert.ok(verify('sha256', Buffer.from(input), { key: PUBLIC, dsaEncoding: 'ieee-p1363' }, sig), 'signature verifies');
});

test('client secret accepts a key stored with literal \\n escapes', async () => {
  const escaped = PEM.replace(/\n/g, '\\n');
  const { input, sig } = decodeJwt(await makeAppleClientSecret({ privateKeyPem: escaped }));
  assert.ok(verify('sha256', Buffer.from(input), { key: PUBLIC, dsaEncoding: 'ieee-p1363' }, sig));
});

test('exchanges the code for a refresh_token, then revokes that refresh_token', async () => {
  const apple = appleFetch({
    '/auth/token': () => jsonRes({ access_token: 'AT', refresh_token: 'RT-123', id_token: idToken(APPLE_SUB) }),
    '/auth/revoke': () => new Response('', { status: 200 }),
  });
  const result = await revokeAppleAuthorization({ authorizationCode: 'CODE-1', appleUserIds: [APPLE_SUB], privateKeyPem: PEM, fetchImpl: apple.fn });
  assert.deepEqual(result, { revoked: true });
  assert.deepEqual(apple.calls.map((c) => c.path), ['/auth/token', '/auth/revoke']);
  assert.ok(apple.calls.every((c) => c.host === 'appleid.apple.com'));

  const [tok, rev] = apple.calls;
  assert.equal(tok.params.grant_type, 'authorization_code');
  assert.equal(tok.params.code, 'CODE-1');
  assert.equal(tok.params.client_id, 'com.broadwayscorecard.app');
  assert.equal(decodeJwt(tok.params.client_secret).payload.sub, 'com.broadwayscorecard.app');
  assert.equal(rev.params.token, 'RT-123');
  assert.equal(rev.params.token_type_hint, 'refresh_token');
  assert.equal(rev.params.client_id, 'com.broadwayscorecard.app');
});

test('reports invalid_client from the token step (key not enabled for the app) without revoking', async () => {
  const apple = appleFetch({ '/auth/token': () => jsonRes({ error: 'invalid_client' }, 400) });
  const result = await revokeAppleAuthorization({ authorizationCode: 'C', appleUserIds: [APPLE_SUB], privateKeyPem: PEM, fetchImpl: apple.fn });
  assert.deepEqual(result, { revoked: false, reason: 'token_invalid_client' });
  assert.equal(apple.calls.length, 1);
});

test('revoke endpoint errors, network failures and missing config never throw', async () => {
  const revokeFails = appleFetch({
    '/auth/token': () => jsonRes({ refresh_token: 'RT', id_token: idToken(APPLE_SUB) }),
    '/auth/revoke': () => new Response('boom', { status: 503 }),
  });
  assert.deepEqual(
    await revokeAppleAuthorization({ authorizationCode: 'C', appleUserIds: [APPLE_SUB], privateKeyPem: PEM, fetchImpl: revokeFails.fn }),
    { revoked: false, reason: 'revoke_http_503' },
  );
  const offline = async () => { throw new TypeError('network down'); };
  assert.deepEqual(
    await revokeAppleAuthorization({ authorizationCode: 'C', appleUserIds: [APPLE_SUB], privateKeyPem: PEM, fetchImpl: offline }),
    { revoked: false, reason: 'error' },
  );
  const ids = [APPLE_SUB];
  assert.deepEqual(await revokeAppleAuthorization({ authorizationCode: 'C', appleUserIds: ids, privateKeyPem: '', fetchImpl: offline }), { revoked: false, reason: 'not_configured' });
  assert.deepEqual(await revokeAppleAuthorization({ authorizationCode: '', appleUserIds: ids, privateKeyPem: PEM, fetchImpl: offline }), { revoked: false, reason: 'no_code' });
  assert.deepEqual(await revokeAppleAuthorization({ authorizationCode: 'C', appleUserIds: [], privateKeyPem: PEM, fetchImpl: offline }), { revoked: false, reason: 'no_apple_identity' });
});

test('a hung Apple endpoint times out instead of holding the deletion', async () => {
  const hang = (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const result = await revokeAppleAuthorization({ authorizationCode: 'C', appleUserIds: [APPLE_SUB], privateKeyPem: PEM, fetchImpl: hang, timeoutMs: 50 });
  assert.deepEqual(result, { revoked: false, reason: 'timeout' });
});

test('a code that belongs to a different Apple user is never revoked', async () => {
  const apple = appleFetch({ '/auth/token': () => jsonRes({ refresh_token: 'RT', id_token: idToken('someone-else') }) });
  const result = await revokeAppleAuthorization({ authorizationCode: 'C', appleUserIds: [APPLE_SUB], privateKeyPem: PEM, fetchImpl: apple.fn });
  assert.deepEqual(result, { revoked: false, reason: 'sub_mismatch' });
  assert.deepEqual(apple.calls.map((c) => c.path), ['/auth/token']);
});

// ─── The edge-function handler ───────────────────────────────────────────

const USER = '11111111-2222-3333-4444-555555555555';
const JWT = `x.${Buffer.from(JSON.stringify({ sub: USER })).toString('base64url')}.y`;
const ENV = { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc', APPLE_PRIVATE_KEY: PEM };

/** Supabase REST/Admin calls succeed (empty selects; the admin user lookup
 *  returns `identities`); Apple calls go to `apple`. */
function fullFetch(apple, identities = [{ provider: 'apple', identity_data: { sub: APPLE_SUB } }]) {
  const supabaseCalls = [];
  const fn = async (url, init = {}) => {
    if (String(url).startsWith('https://appleid.apple.com')) return apple.fn(url, init);
    const u = new URL(url);
    supabaseCalls.push(`${init.method || 'GET'} ${u.pathname}${decodeURIComponent(u.search)}`);
    if ((init.method || 'GET') !== 'GET') return new Response(null, { status: 204 });
    return u.pathname.startsWith('/auth/v1/admin/users/') ? jsonRes({ id: USER, identities }) : jsonRes([]);
  };
  return { fn, supabaseCalls };
}

function deleteRequest(body) {
  return new Request('https://proj.supabase.co/functions/v1/delete-account', {
    method: 'POST',
    headers: { authorization: `Bearer ${JWT}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('handler: deletion succeeds and reports revoked: true when Apple accepts', async () => {
  const apple = appleFetch({
    '/auth/token': () => jsonRes({ refresh_token: 'RT', id_token: idToken(APPLE_SUB) }),
    '/auth/revoke': () => new Response('', { status: 200 }),
  });
  const f = fullFetch(apple);
  const res = await handleDeleteAccount(deleteRequest({ appleAuthorizationCode: 'CODE' }), { env: (k) => ENV[k], fetch: f.fn });
  assert.deepEqual(await res.json(), { ok: true, revoked: true });
  assert.ok(f.supabaseCalls.includes(`DELETE /auth/v1/admin/users/${USER}`));
  assert.deepEqual(apple.calls.map((c) => c.path), ['/auth/token', '/auth/revoke']);
});

test('handler: deletion still succeeds when Apple revoke errors', async () => {
  const apple = appleFetch({
    '/auth/token': () => jsonRes({ refresh_token: 'RT', id_token: idToken(APPLE_SUB) }),
    '/auth/revoke': () => jsonRes({ error: 'invalid_request' }, 400),
  });
  const f = fullFetch(apple);
  const res = await handleDeleteAccount(deleteRequest({ appleAuthorizationCode: 'CODE' }), { env: (k) => ENV[k], fetch: f.fn });
  assert.deepEqual(await res.json(), { ok: true, revoked: false, revokeReason: 'revoke_invalid_request' });
  assert.ok(f.supabaseCalls.includes(`DELETE /auth/v1/admin/users/${USER}`), 'auth user deleted');
  assert.ok(f.supabaseCalls.includes(`DELETE /rest/v1/profiles?id=eq.${USER}`), 'profile deleted');
});

test('handler: deletion still succeeds when the revoke helper itself throws', async () => {
  const f = fullFetch(appleFetch({}));
  const revoke = async () => { throw new Error('unexpected'); };
  const res = await handleDeleteAccount(deleteRequest({ appleAuthorizationCode: 'CODE' }), { env: (k) => ENV[k], fetch: f.fn, revoke });
  assert.deepEqual(await res.json(), { ok: true, revoked: false, revokeReason: 'error' });
});

test('handler: no code (older app builds, non-Apple users) deletes without calling Apple', async () => {
  for (const body of [undefined, {}, { appleAuthorizationCode: 42 }]) {
    const apple = appleFetch({});
    const f = fullFetch(apple);
    const res = await handleDeleteAccount(deleteRequest(body), { env: (k) => ENV[k], fetch: f.fn });
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(apple.calls.length, 0);
  }
});

test('handler: the body can never pick another user to delete', async () => {
  const f = fullFetch(appleFetch({}));
  await handleDeleteAccount(deleteRequest({ userId: 'someone-else', user_id: 'someone-else' }), { env: (k) => ENV[k], fetch: f.fn });
  assert.ok(f.supabaseCalls.every((c) => !c.includes('someone-else')));
  assert.ok(f.supabaseCalls.includes(`DELETE /auth/v1/admin/users/${USER}`));
});

test('handler: an account without an Apple identity is deleted and Apple is never called', async () => {
  const apple = appleFetch({});
  const f = fullFetch(apple, [{ provider: 'google', identity_data: { sub: 'g-1' } }]);
  const res = await handleDeleteAccount(deleteRequest({ appleAuthorizationCode: 'CODE' }), { env: (k) => ENV[k], fetch: f.fn });
  assert.deepEqual(await res.json(), { ok: true, revoked: false, revokeReason: 'no_apple_identity' });
  assert.equal(apple.calls.length, 0);
  assert.ok(f.supabaseCalls.includes(`DELETE /auth/v1/admin/users/${USER}`));
});

test('handler: a failed deletion never revokes the Apple grant', async () => {
  const apple = appleFetch({});
  const f = fullFetch(apple);
  const failing = async (url, init = {}) => (init.method === 'DELETE' && String(url).includes('/rest/v1/reviews') ? new Response('', { status: 500 }) : f.fn(url, init));
  const res = await handleDeleteAccount(deleteRequest({ appleAuthorizationCode: 'CODE' }), { env: (k) => ENV[k], fetch: failing });
  assert.deepEqual(await res.json(), { ok: false, error: 'internal' });
  assert.equal(apple.calls.length, 0);
});

test('a 5xx or dropped connection on revoke is retried once (the code cannot be replayed)', async () => {
  let revokes = 0;
  const flaky = appleFetch({
    '/auth/token': () => jsonRes({ refresh_token: 'RT', id_token: idToken(APPLE_SUB) }),
    '/auth/revoke': () => (++revokes === 1 ? new Response('', { status: 503 }) : new Response('', { status: 200 })),
  });
  assert.deepEqual(await revokeAppleAuthorization({ authorizationCode: 'C', appleUserIds: [APPLE_SUB], privateKeyPem: PEM, fetchImpl: flaky.fn }), { revoked: true });
  assert.deepEqual(flaky.calls.map((c) => c.path), ['/auth/token', '/auth/revoke', '/auth/revoke']);

  let drops = 0;
  const dropping = appleFetch({
    '/auth/token': () => jsonRes({ refresh_token: 'RT', id_token: idToken(APPLE_SUB) }),
    '/auth/revoke': () => { if (++drops === 1) throw new TypeError('connection reset'); return new Response('', { status: 200 }); },
  });
  assert.deepEqual(await revokeAppleAuthorization({ authorizationCode: 'C', appleUserIds: [APPLE_SUB], privateKeyPem: PEM, fetchImpl: dropping.fn }), { revoked: true });

  const badRequest = appleFetch({
    '/auth/token': () => jsonRes({ refresh_token: 'RT', id_token: idToken(APPLE_SUB) }),
    '/auth/revoke': () => jsonRes({ error: 'invalid_request' }, 400),
  });
  await revokeAppleAuthorization({ authorizationCode: 'C', appleUserIds: [APPLE_SUB], privateKeyPem: PEM, fetchImpl: badRequest.fn });
  assert.equal(badRequest.calls.length, 2, 'a 4xx is final, not retried');
});

test('handler: a failed Apple identity lookup still deletes, reported as identity_lookup_failed', async () => {
  const apple = appleFetch({});
  const f = fullFetch(apple);
  const lookupFails = async (url, init = {}) =>
    (init.method || 'GET') === 'GET' && String(url).includes('/auth/v1/admin/users/') ? new Response('', { status: 503 }) : f.fn(url, init);
  const res = await handleDeleteAccount(deleteRequest({ appleAuthorizationCode: 'CODE' }), { env: (k) => ENV[k], fetch: lookupFails });
  assert.deepEqual(await res.json(), { ok: true, revoked: false, revokeReason: 'identity_lookup_failed' });
  assert.equal(apple.calls.length, 0);
  assert.ok(f.supabaseCalls.includes(`DELETE /auth/v1/admin/users/${USER}`));
});
