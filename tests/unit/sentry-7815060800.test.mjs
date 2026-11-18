// BRO-7733 / Sentry 7815060800: "UgcError: UGC functions mezzanine-search failed (500)".
// The browser's instrumentedFetch reports every non-2xx Supabase functions
// response to Sentry. The mezzanine-search edge function answered 500 for any
// error from theaterdiary.com's Parse API (5xx, network failure), although its
// own error contract says handled failures are HTTP 200 {ok:false}. A
// third-party outage is handled: it must not be a 500.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findShowsByTitle,
  findProductionsForShow,
  getShow,
  errorOutcome,
} from '../../supabase/functions/mezzanine-search/parse-client.mjs';

async function caughtFrom(t, fetchImpl, call) {
  t.mock.method(globalThis, 'fetch', fetchImpl);
  try {
    await call();
  } catch (e) {
    return e;
  }
  assert.fail('expected the Parse call to throw');
}

const upstream500 = async () => new Response('{"error":"boom"}', { status: 500 });
const upstream503 = async () => new Response('Service Unavailable', { status: 503 });
const networkDown = async () => { throw new TypeError('error sending request for url'); };
const htmlBody = async () => new Response('<html>gateway</html>', { status: 200 });

for (const [name, impl] of [['HTTP 500', upstream500], ['HTTP 503', upstream503], ['network error', networkDown], ['non-JSON 200', htmlBody]]) {
  test(`upstream ${name} becomes a handled 200 {ok:false}, not a 500 that Sentry sees`, async t => {
    for (const call of [
      () => findShowsByTitle('hamilton', 'app', 'tok'),
      () => findProductionsForShow('abc123', 'app', 'tok'),
      () => getShow('abc123', 'app', 'tok'),
    ]) {
      const err = await caughtFrom(t, impl, call);
      t.mock.restoreAll();
      const outcome = errorOutcome(err);
      assert.equal(outcome.status, 200, `${name}: ${err.message}`);
      assert.deepEqual(outcome.body, { ok: false, error: 'upstream_unavailable' });
    }
  });
}

test('upstream auth failure keeps its upstream_auth answer', async t => {
  const err = await caughtFrom(t, async () => new Response('{}', { status: 401 }), () => findShowsByTitle('hamilton', 'app', 'tok'));
  assert.deepEqual(errorOutcome(err), { status: 200, body: { ok: false, error: 'upstream_auth' } });
});

test('our own bugs still answer 500 so they stay visible in Sentry', () => {
  assert.deepEqual(errorOutcome(new Error('rate-limit log insert failed: 500')), { status: 500, body: { ok: false, error: 'internal' } });
  assert.deepEqual(errorOutcome(new TypeError("Cannot read properties of undefined (reading 'objectId')")).status, 500);
});

test('the client has user copy for the new upstream_unavailable code', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  require('tsx/cjs/api').register();
  const Module = require('node:module');
  const originalLoad = Module._load;
  Module._load = function (name, ...args) {
    if (name === '@/lib/supabase') return { getSupabaseClient: async () => null };
    return originalLoad.call(this, name, ...args);
  };
  try {
    const { MEZZANINE_SEARCH_ERROR_COPY } = require('../../src/lib/mezzanine-search.ts');
    assert.match(MEZZANINE_SEARCH_ERROR_COPY.upstream_unavailable, /wider catalog/);
  } finally {
    Module._load = originalLoad;
  }
});
