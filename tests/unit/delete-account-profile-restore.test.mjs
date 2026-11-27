// BRO-8383: "UGC insert reviews failed (23503)" kept coming back (BRO-7726,
// BRO-7727, BRO-8031). Every case was a signed-in user whose profiles row was
// missing. delete-account deleted the profile before the auth user, so a failed
// auth-user delete left a live login with no profile, and every save after it
// failed with 23503. The handler must put the profile back in that case.
// Runs the real handler with fetch mocked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleDeleteAccount } from '../../supabase/functions/delete-account/handler.mjs';

const USER = '11111111-2222-3333-4444-555555555555';
const JWT = `x.${Buffer.from(JSON.stringify({ sub: USER })).toString('base64url')}.y`;
const ENV = { SUPABASE_URL: 'https://proj.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc' };
const PROFILE = { id: USER, display_name: 'Pat', avatar_url: null, onboarding_seen_at: '2026-11-01T00:00:00Z' };

function jsonRes(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** authDelete: 'ok' | 'fail500' | 'throw' | 'gone404' */
function supabase(authDelete) {
  const calls = [];
  let profileRows = [PROFILE];
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    calls.push({ method, path: u.pathname, search: decodeURIComponent(u.search), body: init.body });
    if (u.pathname === `/auth/v1/admin/users/${USER}` && method === 'DELETE') {
      if (authDelete === 'throw') throw new TypeError('fetch failed');
      if (authDelete === 'fail500') return jsonRes({ msg: 'Database error deleting user' }, 500);
      if (authDelete === 'gone404') return jsonRes({}, 404);
      return new Response(null, { status: 200 });
    }
    if (u.pathname === '/rest/v1/profiles') {
      if (method === 'GET') return jsonRes(u.searchParams.get('offset') === '0' ? profileRows : []);
      if (method === 'DELETE') { profileRows = []; return new Response(null, { status: 204 }); }
      if (method === 'POST') { profileRows = JSON.parse(init.body); return new Response(null, { status: 201 }); }
    }
    if (method !== 'GET') return new Response(null, { status: 204 });
    return jsonRes([]);
  };
  return { fn, calls, profile: () => profileRows };
}

const request = () => new Request('https://proj.supabase.co/functions/v1/delete-account', {
  method: 'POST', headers: { authorization: `Bearer ${JWT}` },
});

for (const mode of ['fail500', 'throw']) {
  test(`failed auth-user delete (${mode}) restores the profile row and reports failure`, async () => {
    const sb = supabase(mode);
    const errs = [];
    const orig = console.error; console.error = (...a) => errs.push(a.join(' '));
    try {
      const res = await handleDeleteAccount(request(), { env: (k) => ENV[k], fetch: sb.fn });
      assert.deepEqual(await res.json(), { ok: false, error: 'internal' });
    } finally { console.error = orig; }
    assert.deepEqual(sb.profile(), [PROFILE], 'profile row is back, so later saves do not 23503');
    const restore = sb.calls.find((c) => c.method === 'POST' && c.path === '/rest/v1/profiles');
    assert.ok(restore, 'profile re-inserted');
    assert.match(restore.search, /on_conflict=id/);
  });
}

for (const mode of ['ok', 'gone404']) {
  test(`successful auth-user delete (${mode}) leaves no profile and restores nothing`, async () => {
    const sb = supabase(mode);
    const res = await handleDeleteAccount(request(), { env: (k) => ENV[k], fetch: sb.fn });
    assert.deepEqual(await res.json(), { ok: true });
    assert.deepEqual(sb.profile(), []);
    assert.ok(!sb.calls.some((c) => c.method === 'POST' && c.path === '/rest/v1/profiles'));
  });
}
