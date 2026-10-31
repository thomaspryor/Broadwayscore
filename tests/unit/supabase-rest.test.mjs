import test from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('tsx/cjs/api').register();

// Load the real REST module, replacing only its browser/network dependencies.
function setup(t, { status = 409, body = {}, userError = null, refreshError = null } = {}) {
  const calls = { signOut: [], pendingCleared: 0, events: [], reports: [], requests: [] };
  const client = { auth: {
    getUser: async () => ({ data: { user: userError ? null : { id: 'deleted-user' } }, error: userError }),
    refreshSession: async () => ({ error: refreshError }),
    getSession: async () => ({ data: { session: { access_token: 'test-token' } } }),
    signOut: async (options) => { calls.signOut.push(options); },
  } };
  const previousWindow = globalThis.window;
  globalThis.window = { dispatchEvent: event => calls.events.push(event.type) };
  t.after(() => { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; });
  const originalLoad = Module._load;
  const loader = t.mock.method(Module, '_load', function (name, ...args) {
    if (name === './supabase') return { getSupabaseClient: async () => client };
    if (name === './deferred-auth') return { clearPendingAction: () => calls.pendingCleared++ };
    if (name === './ugc-analytics') return {
      instrumentedFetch: async (url, options) => {
        calls.requests.push({ url, ...options });
        return new Response(status === 204 ? null : JSON.stringify(body), { status });
      },
      reportUgcError: (...args) => calls.reports.push(args),
    };
    return originalLoad.call(this, name, ...args);
  });
  const path = require.resolve('../../src/lib/supabase-rest.ts');
  delete require.cache[path];
  const rest = require(path);
  loader.mock.restore();
  return { rest, calls, client };
}

const userFk = {
  code: '23503',
  message: 'insert or update on table "watchlist" violates foreign key constraint "watchlist_user_id_fkey"',
};

test('deleted-account watchlist insert clears the local session and pending action, notifies and reports', async t => {
  const { rest, calls } = setup(t, { body: userFk });
  const result = await rest.supabaseRestInsert('watchlist', { user_id: 'deleted-user', show_id: 'hamilton-2015' });
  assert.equal(result.error.code, 'account_gone');
  assert.equal(result.error.message, 'Your account no longer exists on this device; sign in again');
  assert.deepEqual(calls.signOut, [{ scope: 'local' }]);
  assert.equal(calls.pendingCleared, 1);
  assert.deepEqual(calls.events, [rest.ACCOUNT_GONE_EVENT]);
  assert.equal(calls.reports[0][0], 'insert watchlist');
  assert.equal(calls.reports[0][1].code, 'account_gone');
});

for (const [method, args] of [
  ['supabaseRestInsert', ['watchlist', {}]],
  ['supabaseRestUpsert', ['reviews', {}, 'id']],
  ['supabaseRestUpdate', ['watchlist', 'id=eq.1', {}]],
  ['supabaseRestDelete', ['watchlist', 'id=eq.1']],
  ['supabaseRestSelect', ['profiles', 'select=id']],
  ['supabaseRestRpc', ['my_onboarding', {}]],
]) {
  test(`${method} recovers from a 401`, async t => {
    const { rest, calls } = setup(t, { status: 401, body: { message: 'JWT expired' } });
    assert.equal((await rest[method](...args)).error.code, 'account_gone');
    assert.deepEqual(calls.signOut, [{ scope: 'local' }]);
  });
}

for (const body of [
  { code: '23503', message: 'violates foreign key constraint "list_items_list_id_fkey"' },
  { code: '23503', message: 'violates foreign key constraint "watchlist_show_id_fkey"' },
  { code: '23505', message: 'duplicate watchlist_user_id_fkey' },
  { code: '42501', message: 'row-level security policy for user_id' },
]) {
  test(`unrelated ${body.code} ${body.message} keeps the session`, async t => {
    const { rest, calls } = setup(t, { body });
    assert.deepEqual((await rest.supabaseRestInsert('watchlist', {})).error, body);
    assert.deepEqual(calls.signOut, []);
    assert.equal(calls.pendingCleared, 0);
    assert.deepEqual(calls.events, []);
  });
}

test('getUser user_not_found recovers before a write can leave the browser', async t => {
  const { rest, calls } = setup(t, { userError: { code: 'user_not_found', status: 403 } });
  assert.equal((await rest.supabaseRestInsert('watchlist', {})).error.code, 'account_gone');
  assert.deepEqual(calls.signOut, [{ scope: 'local' }]);
  assert.equal(calls.requests.length, 0);
});

test('offline validation and refresh failure do not delete the local session', async t => {
  const { rest, calls } = setup(t, { userError: { status: 0 }, refreshError: { status: 0 } });
  assert.match((await rest.supabaseRestInsert('watchlist', {})).error.message, /No valid session/);
  assert.deepEqual(calls.signOut, []);
});

test('simultaneous failures share local sign-out and notification', async t => {
  const { rest, calls, client } = setup(t, { body: userFk });
  let release;
  client.auth.signOut = options => {
    calls.signOut.push(options);
    return new Promise(resolve => { release = resolve; });
  };
  const saves = [rest.supabaseRestInsert('watchlist', {}), rest.supabaseRestUpsert('reviews', {}, 'id')];
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.signOut.length, 1);
  release();
  const results = await Promise.all(saves);
  assert.ok(results.every(result => result.error.code === 'account_gone'));
  assert.equal(calls.events.length, 1);
});

test('successful writes preserve their result and make no recovery calls', async t => {
  const { rest, calls } = setup(t, { status: 201, body: [{ id: 'saved' }] });
  assert.deepEqual(await rest.supabaseRestInsert('watchlist', {}), { data: { id: 'saved' }, error: null });
  assert.deepEqual(await rest.supabaseRestInsert('user_show_stubs', {}, { returning: 'minimal' }), { data: null, error: null });
  assert.deepEqual(calls.signOut, []);
});
