import test from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('tsx/cjs/api').register();
const { buildQueries } = require('../../scripts/lib/account-metrics.js');

test('account monitoring excludes handled recovery from its error-spike counts', () => {
  const query = buildQueries().health;
  assert.match(query, /NOT IN \([^)]*'account_gone'/);
  assert.doesNotMatch(query, /NOT IN \([^)]*'(?:23503|42501|XX000)'/);
});

// Exercise the real REST recovery and telemetry together. Only external
// Supabase/browser dependencies are replaced; no recovery logic is copied.
function setup(t, { status = 201, body = [{ id: 'saved' }], userError = null } = {}) {
  const calls = { sentry: [], posthog: [], signOut: [], events: [], removed: [], requests: 0 };
  const client = { auth: {
    getUser: async () => ({ data: { user: userError ? null : { id: 'test-user' } }, error: userError }),
    getSession: async () => ({ data: { session: { access_token: 'test-token' } } }),
    signOut: async options => { calls.signOut.push(options); },
  } };
  for (const [key, value] of Object.entries({
    window: {
      location: { pathname: '/my-shows' },
      posthog: { capture: (event, props) => calls.posthog.push({ event, props }) },
      Sentry: { captureException: (error, context) => calls.sentry.push({ error, context }) },
      dispatchEvent: event => calls.events.push(event.type),
    },
    localStorage: { removeItem: key => calls.removed.push(key) },
    fetch: async () => { calls.requests++; return new Response(JSON.stringify(body), { status }); },
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else delete globalThis[key];
    });
  }
  const originalLoad = Module._load;
  const loader = t.mock.method(Module, '_load', function (name, ...args) {
    if (name === './supabase') return { getSupabaseClient: async () => client };
    return originalLoad.call(this, name, ...args);
  });
  for (const file of ['ugc-analytics', 'supabase-rest']) {
    delete require.cache[require.resolve(`../../src/lib/${file}.ts`)];
  }
  const rest = require('../../src/lib/supabase-rest.ts');
  const analytics = require('../../src/lib/ugc-analytics.ts');
  loader.mock.restore();
  return { calls, rest, analytics };
}

// BRO-7726's reported title is emitted by accountGone(), after the session
// failure is classified. A 401 was already quiet; 403/409 and no status were not.
for (const status of [undefined, 401, 403, 409]) {
  test(`account_gone (${status ?? 'no status'}) stays in PostHog, out of Sentry for every REST operation`, t => {
    const { calls, analytics, rest } = setup(t);
    for (const op of ['insert reviews', 'insert watchlist', 'update reviews', 'delete reviews', 'select profiles', 'rpc my_onboarding']) {
      analytics.reportUgcError(op, { message: rest.ACCOUNT_GONE_MESSAGE, code: 'account_gone', status });
    }
    assert.equal(calls.posthog.length, 6);
    assert.ok(calls.posthog.every(({ event, props }) => event === 'ugc_error' && props.error_code === 'account_gone'));
    assert.equal(calls.sentry.length, 0);
  });
}

for (const scenario of [
  { name: 'deleted user at auth validation', userError: { code: 'user_not_found', status: 403 }, requests: 0, rawCodes: [] },
  { name: 'expired JWT at save', status: 401, body: { message: 'JWT expired' }, requests: 1, rawCodes: [] },
  { name: 'deleted user at save', status: 409, body: { code: '23503', message: 'insert or update on table "reviews" violates foreign key constraint "reviews_user_id_fkey"' }, requests: 1, rawCodes: ['23503'] },
]) {
  test(`${scenario.name}: recovery still clears the session and draft and prompts sign-in`, async t => {
    const { calls, rest } = setup(t, scenario);
    const result = await rest.supabaseRestInsert('reviews', { user_id: 'test-user', show_id: 'hamilton-2015', rating: 4 });
    assert.equal(result.error.code, 'account_gone');
    assert.equal(result.error.message, rest.ACCOUNT_GONE_MESSAGE);
    assert.deepEqual(calls.signOut, [{ scope: 'local' }]);
    assert.deepEqual(calls.removed, ['bsc_pending_action']);
    assert.deepEqual(calls.events, [rest.ACCOUNT_GONE_EVENT]);
    assert.equal(calls.requests, scenario.requests);
    assert.equal(calls.posthog.filter(({ props }) => props.error_code === 'account_gone').length, 1);
    // Raw database errors remain actionable, including the original 23503.
    assert.deepEqual(calls.sentry.map(({ context }) => context.tags.ugc_code), scenario.rawCodes);
  });
}

test('successful review insert and unexpected failures retain their existing behavior', async t => {
  const { calls, rest, analytics } = setup(t);
  assert.deepEqual(await rest.supabaseRestInsert('reviews', {}), { data: { id: 'saved' }, error: null });
  assert.equal(calls.sentry.length, 0);
  assert.equal(calls.posthog.length, 0);
  assert.equal(calls.signOut.length, 0);
  for (const info of [
    { code: '23503', status: 409, message: 'violates foreign key constraint "reviews_show_id_fkey"' },
    { code: '42501', status: 403, message: 'row-level security policy for reviews' },
    { code: 'XX000', status: 500, message: 'internal error' },
  ]) analytics.reportUgcError('insert reviews', info);
  assert.deepEqual(calls.sentry.map(({ context }) => context.tags.ugc_code), ['23503', '42501', 'XX000']);
  assert.equal(calls.posthog.length, 3);
});
