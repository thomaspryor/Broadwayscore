/**
 * Shared Plans loader (src/lib/shared-plans/load.ts, BRO-4481).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSharedPlansWith, noStoreFetch, type RpcClient } from '../../src/lib/shared-plans/load';

const TOKEN = 'a'.repeat(32);
const PAYLOAD = {
  name: 'Tom', showBooked: true, showUnbooked: true,
  entries: [{ show_id: 'wicked-2003', planned_date: '2026-10-18', logged: false }, { show_id: 'x', planned_date: null, logged: false }],
};

function client(result: { data: unknown; error: unknown } | Error, seen: unknown[] = []): RpcClient {
  return {
    rpc(fn, args) {
      seen.push([fn, args]);
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
  };
}

test('ok: returns the payload and calls get_shared_plans with the token', async () => {
  const seen: unknown[] = [];
  const r = await loadSharedPlansWith(TOKEN, client({ data: PAYLOAD, error: null }, seen));
  assert.deepEqual(r, { status: 'ok', payload: PAYLOAD });
  assert.deepEqual(seen, [['get_shared_plans', { p_token: TOKEN }]]);
});

test('message text pasted after the token is dropped (share sheets that join text + url)', async () => {
  for (const param of [`${TOKEN} My theater plans on Broadway Scorecard`, `${TOKEN}%20My%20theater%20plans%20on%20Broadway%20Scorec`, ` ${TOKEN}\n`]) {
    const seen: unknown[] = [];
    const r = await loadSharedPlansWith(param, client({ data: PAYLOAD, error: null }, seen));
    assert.deepEqual(r, { status: 'ok', payload: PAYLOAD });
    assert.deepEqual(seen, [['get_shared_plans', { p_token: TOKEN }]]);
  }
});

test('null from the function means not shared (404), not an error', async () => {
  assert.deepEqual(await loadSharedPlansWith(TOKEN, client({ data: null, error: null })), { status: 'not-shared' });
});

test('malformed tokens never reach the database', async () => {
  const seen: unknown[] = [];
  for (const bad of ['', 'abc', 'A'.repeat(32), `${'a'.repeat(31)}g`, `${'a'.repeat(32)}/../x`, `${'a'.repeat(32)}x more`, '%E0%A4%A']) {
    assert.deepEqual(await loadSharedPlansWith(bad, client({ data: PAYLOAD, error: null }, seen)), { status: 'not-shared' });
  }
  assert.equal(seen.length, 0);
});

test('database error, thrown error, missing client and malformed payload are all "unavailable" (503), never 404', async () => {
  assert.deepEqual(await loadSharedPlansWith(TOKEN, client({ data: null, error: { message: 'boom' } })), { status: 'unavailable' });
  assert.deepEqual(await loadSharedPlansWith(TOKEN, client(new Error('network'))), { status: 'unavailable' });
  assert.deepEqual(await loadSharedPlansWith(TOKEN, null), { status: 'unavailable' });
  assert.deepEqual(await loadSharedPlansWith(TOKEN, client({ data: { name: 'x' }, error: null })), { status: 'unavailable' });
  assert.deepEqual(await loadSharedPlansWith(TOKEN, client({
    data: { ...PAYLOAD, entries: [{ show_id: 1, planned_date: null, logged: false }] }, error: null,
  })), { status: 'unavailable' });
});

test('noStoreFetch forces cache: no-store and keeps the caller\'s init', async () => {
  const realFetch = globalThis.fetch;
  let captured: RequestInit | undefined;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    captured = init;
    return new Response('{}');
  }) as typeof fetch;
  try {
    await noStoreFetch('https://example.test/rpc', { method: 'POST', headers: { a: 'b' }, cache: 'force-cache' });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(captured?.cache, 'no-store');
  assert.equal(captured?.method, 'POST');
  assert.deepEqual(captured?.headers, { a: 'b' });
});
