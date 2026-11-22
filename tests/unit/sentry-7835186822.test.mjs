// BRO-8031 / Sentry 7835186822: "UgcError: UGC insert reviews failed (23503)",
// regressed after BRO-7727. reviews.user_id references public.profiles(id), so
// a signed-in user (getUser() succeeds) with no profiles row got 23503 on every
// save: BRO-7727 signed them out and instrumentedFetch still sent the raw 23503
// to Sentry. The REST helper must recreate the profile and retry the save.
import test from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('tsx/cjs/api').register();

const fk = (table, constraint) => ({
  code: '23503',
  message: `insert or update on table "${table}" violates foreign key constraint "${constraint}"`,
  details: 'Key (user_id)=(test-user) is not present in table "profiles".',
});

// Real supabase-rest + ugc-analytics; only the Supabase client, network and
// browser globals are replaced. `respond(table, n)` answers the nth request.
function setup(t, respond) {
  const calls = { sentry: [], posthog: [], signOut: [], requests: [] };
  const client = { auth: {
    getUser: async () => ({ data: { user: { id: 'test-user' } }, error: null }),
    getSession: async () => ({ data: { session: { access_token: 'test-token', user: { id: 'test-user', user_metadata: { full_name: 'Test User' } } } } }),
    signOut: async options => { calls.signOut.push(options); },
  } };
  for (const [key, value] of Object.entries({
    window: {
      location: { pathname: '/my-shows' },
      posthog: { capture: (event, props) => calls.posthog.push({ event, props }) },
      Sentry: { captureException: (error, context) => calls.sentry.push({ error, context }) },
      dispatchEvent: () => {},
    },
    localStorage: { removeItem: () => {} },
    fetch: async (url, init) => {
      const table = new URL(url, 'https://x.invalid').pathname.split('/').pop();
      calls.requests.push({ table, body: init?.body ? JSON.parse(init.body) : null });
      const [status, body] = respond(table, calls.requests.filter(r => r.table === table).length);
      return new Response(status === 201 && body == null ? null : JSON.stringify(body), { status });
    },
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else delete globalThis[key]; });
  }
  const originalLoad = Module._load;
  const loader = t.mock.method(Module, '_load', function (name, ...args) {
    if (name === './supabase') return { getSupabaseClient: async () => client };
    return originalLoad.call(this, name, ...args);
  });
  for (const file of ['missing-profile', 'ugc-analytics', 'supabase-rest']) {
    delete require.cache[require.resolve(`../../src/lib/${file}.ts`)];
  }
  const rest = require('../../src/lib/supabase-rest.ts');
  const analytics = require('../../src/lib/ugc-analytics.ts');
  loader.mock.restore();
  return { calls, rest, analytics };
}

// The reported issue plus its cousins: every UGC write whose user_id references profiles.
for (const [label, run, table] of [
  ['insert reviews', rest => rest.supabaseRestInsert('reviews', { user_id: 'test-user', show_id: 'hamilton-2015', rating: 4 }), 'reviews'],
  ['insert watchlist', rest => rest.supabaseRestInsert('watchlist', { user_id: 'test-user', show_id: 'hamilton-2015' }), 'watchlist'],
  ['upsert diary_shares', rest => rest.supabaseRestUpsert('diary_shares', { user_id: 'test-user' }, 'user_id'), 'diary_shares'],
]) {
  test(`${label}: missing profile row is recreated and the save succeeds, nothing reaches Sentry`, async t => {
    const { calls, rest } = setup(t, (tbl, n) => {
      if (tbl === 'profiles') return [201, null];
      return n === 1 ? [409, fk(tbl, `${tbl}_user_id_fkey`)] : [201, [{ id: 'saved' }]];
    });
    const result = await run(rest);
    assert.deepEqual(result, { data: { id: 'saved' }, error: null });
    assert.deepEqual(calls.requests.map(r => r.table), [table, 'profiles', table]);
    assert.deepEqual(calls.requests[1].body, { id: 'test-user', display_name: 'Test User', avatar_url: null });
    assert.deepEqual(calls.signOut, []);
    assert.deepEqual(calls.sentry, []);
    // Still counted in PostHog, so the rate stays visible.
    assert.equal(calls.posthog.filter(({ props }) => props.error_code === '23503').length, 1);
  });
}

test('auth user gone at repair: handled sign-out, no Sentry event', async t => {
  const { calls, rest } = setup(t, tbl => tbl === 'profiles'
    ? [409, fk('profiles', 'profiles_id_fkey')]
    : [409, fk(tbl, `${tbl}_user_id_fkey`)]);
  const result = await rest.supabaseRestInsert('reviews', { user_id: 'test-user', show_id: 'hamilton-2015' });
  assert.equal(result.error.code, 'account_gone');
  assert.deepEqual(calls.signOut, [{ scope: 'local' }]);
  assert.deepEqual(calls.requests.map(r => r.table), ['reviews', 'profiles']);
  assert.deepEqual(calls.sentry, []);
});

test('repair refused for another reason is reported once as profile_heal_failed', async t => {
  const { calls, rest } = setup(t, tbl => tbl === 'profiles'
    ? [403, { code: '42501', message: 'new row violates row-level security policy for table "profiles"' }]
    : [409, fk(tbl, `${tbl}_user_id_fkey`)]);
  await rest.supabaseRestInsert('reviews', { user_id: 'test-user' });
  assert.deepEqual(calls.sentry.map(({ context }) => context.tags.ugc_code).sort(), ['42501', 'profile_heal_failed']);
});

test('other foreign keys are not repaired and stay actionable in Sentry', async t => {
  const { calls, rest } = setup(t, () => [409, fk('reviews', 'reviews_show_id_fkey')]);
  const result = await rest.supabaseRestInsert('reviews', { user_id: 'test-user', show_id: 'nope' });
  assert.equal(result.error.code, '23503');
  assert.deepEqual(calls.requests.map(r => r.table), ['reviews']);
  assert.deepEqual(calls.sentry.map(({ context }) => context.tags.ugc_code), ['23503']);
});
