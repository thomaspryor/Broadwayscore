import test from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('tsx/cjs/api').register();

test('watchlist user foreign key failure recovers the stale session', async t => {
  const calls = { signOut: [], cleared: 0, events: [] };
  const client = { auth: {
    getUser: async () => ({ data: { user: { id: 'deleted-user' } }, error: null }),
    getSession: async () => ({ data: { session: { access_token: `x.${Buffer.from(JSON.stringify({ sub: 'deleted-user' })).toString('base64url')}.y` } } }),
    signOut: async options => calls.signOut.push(options),
  } };
  const previousWindow = globalThis.window;
  globalThis.window = { dispatchEvent: event => calls.events.push(event.type) };
  t.after(() => { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; });
  const originalLoad = Module._load;
  const loader = t.mock.method(Module, '_load', function (name, ...args) {
    if (name === './supabase') return { getSupabaseClient: async () => client };
    if (name === './deferred-auth') return { clearPendingAction: () => calls.cleared++ };
    if (name === './ugc-analytics') return {
      // BRO-8031: the missing-profile repair of a deleted auth user fails on profiles_id_fkey, which signs the user out.
      instrumentedFetch: async (url) => new Response(JSON.stringify(String(url).includes('/rest/v1/profiles') ? {
        code: '23503',
        message: 'insert or update on table "profiles" violates foreign key constraint "profiles_id_fkey"',
        details: 'Key (id)=(deleted-user) is not present in table "users".',
      } : {
        code: '23503',
        message: 'insert or update on table "watchlist" violates foreign key constraint "watchlist_user_id_fkey"',
        details: 'Key (user_id)=(deleted-user) is not present in table "profiles".',
      }), { status: 409 }),
      reportUgcError: () => {},
    };
    return originalLoad.call(this, name, ...args);
  });
  const path = require.resolve('../../src/lib/supabase-rest.ts');
  delete require.cache[path];
  const rest = require(path);
  loader.mock.restore();

  const result = await rest.supabaseRestInsert('watchlist', { user_id: 'deleted-user', show_id: 'hamilton-2015' });
  assert.equal(result.error.code, 'account_gone');
  assert.deepEqual(calls.signOut, [{ scope: 'local' }]);
  assert.equal(calls.cleared, 1);
  assert.deepEqual(calls.events, [rest.ACCOUNT_GONE_EVENT]);
});
