// BRO-8383: "UGC insert reviews failed (23503)" kept coming back (BRO-7726,
// BRO-7727, BRO-8031). Every case was a signed-in user whose profiles row was
// missing. The signup trigger always creates one, and delete-account was the
// only code that removed it while the login stayed: it deleted the profile
// before the auth user, so a failed auth delete stranded a live login with no
// profile. Now the auth user goes first and the profile cascades with it.
// Runs the real handler with fetch mocked; the mock models the FK cascade.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { handleDeleteAccount } from '../../supabase/functions/delete-account/handler.mjs';

const require = createRequire(import.meta.url);
const { missingRequiredCascades } = require('../../scripts/lib/supabase-schema-expectations.js');

const USER = '11111111-2222-3333-4444-555555555555';
const JWT = `x.${Buffer.from(JSON.stringify({ sub: USER })).toString('base64url')}.y`;
const ENV = { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc' };

function jsonRes(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** authDelete: 'ok' | 'fail500' | 'throw' | 'gone404'. gone404 leaves a
 *  profile the cascade missed, so the safety-net delete is exercised.
 *  profileDelete: 'ok' | 'fail500' */
function supabase(authDelete, profileDelete = 'ok') {
  const calls = [];
  const state = { authUser: authDelete !== 'gone404', profile: true };
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    calls.push(`${method} ${u.pathname}`);
    if (u.pathname === `/auth/v1/admin/users/${USER}` && method === 'DELETE') {
      if (authDelete === 'throw') throw new TypeError('fetch failed');
      if (authDelete === 'fail500') return jsonRes({ msg: 'Database error deleting user' }, 500);
      if (!state.authUser) return jsonRes({}, 404);
      state.authUser = false;
      state.profile = false; // profiles.id REFERENCES auth.users ON DELETE CASCADE
      return new Response(null, { status: 200 });
    }
    if (u.pathname === '/rest/v1/profiles' && method === 'DELETE') {
      if (profileDelete === 'fail500') return jsonRes({}, 500);
      state.profile = false;
      return new Response(null, { status: 204 });
    }
    if (method !== 'GET') return new Response(null, { status: 204 });
    return jsonRes([]);
  };
  return { fn, calls, state };
}

const request = () => new Request('https://proj.supabase.co/functions/v1/delete-account', {
  method: 'POST', headers: { authorization: `Bearer ${JWT}` },
});

async function run(mode, profileDelete) {
  const sb = supabase(mode, profileDelete);
  const orig = console.error; console.error = () => {};
  try {
    const res = await handleDeleteAccount(request(), { env: (k) => ENV[k], fetch: sb.fn });
    return { sb, body: await res.json() };
  } finally { console.error = orig; }
}

for (const mode of ['fail500', 'throw']) {
  test(`failed auth-user delete (${mode}) keeps the profile row, so later saves do not 23503`, async () => {
    const { sb, body } = await run(mode);
    assert.deepEqual(body, { ok: false, error: 'internal' });
    assert.equal(sb.state.authUser, true, 'login still exists');
    assert.equal(sb.state.profile, true, 'profile row still exists for the live login');
    assert.ok(!sb.calls.includes('DELETE /rest/v1/profiles'), 'profile never deleted before the auth user');
  });
}

test('the auth user is deleted before the profile row', async () => {
  const { sb, body } = await run('ok');
  assert.deepEqual(body, { ok: true });
  const authAt = sb.calls.indexOf(`DELETE /auth/v1/admin/users/${USER}`);
  const profAt = sb.calls.indexOf('DELETE /rest/v1/profiles');
  assert.ok(authAt >= 0 && profAt > authAt, `order was ${sb.calls.filter((c) => c.startsWith('DELETE')).join(', ')}`);
  assert.deepEqual(sb.state, { authUser: false, profile: false });
});

test('a retry after a lost response (auth user already gone, 404) succeeds and removes a leftover profile', async () => {
  const { sb, body } = await run('gone404');
  assert.deepEqual(body, { ok: true });
  assert.equal(sb.state.profile, false, 'safety-net delete removed the profile the cascade missed');
});

test('a failed leftover-profile delete after the account is gone still reports success', async () => {
  const { body } = await run('gone404', 'fail500');
  assert.deepEqual(body, { ok: true });
});

test('schema check: missing profiles -> auth.users cascade is reported', () => {
  const rows = [{ kind: 'cascadefk', name: 'reviews:public.profiles' }];
  assert.deepEqual(missingRequiredCascades(rows).map((c) => c.name), ['profiles:auth.users']);
  assert.deepEqual(missingRequiredCascades([...rows, { kind: 'cascadefk', name: 'profiles:auth.users' }]), []);
  assert.deepEqual(missingRequiredCascades([{ kind: 'constraint', name: 'profiles:auth.users' }]).length, 1, 'only cascadefk rows count');
});
