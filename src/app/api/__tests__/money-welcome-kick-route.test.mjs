/**
 * BRO-7704: the real /api/money-welcome-kick POST handler. Only global fetch is stubbed.
 * Run: npx tsx --test src/app/api/__tests__/money-welcome-kick-route.test.mjs
 */
import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
register('./next-subpath-loader.mjs', import.meta.url);

async function callRoute({ secret = 'sek', dbSecret = 'sek', cfgStatus = 200, queued = 0, pending = 0, dispatchStatus = 204, env = {} }) {
  const saved = { ...process.env };
  Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'svc', GH_DISPATCH_TOKEN: 'gh', MONEY_WELCOME_KICK_COOLDOWN_MS: '0', ...env });
  for (const k of Object.keys(env)) if (env[k] === null) delete process.env[k];
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, body: init.body });
    if (u.includes('/rest/v1/money_welcome_kick_config')) return new Response(JSON.stringify(dbSecret === null ? [] : [{ secret: dbSecret }]), { status: cfgStatus });
    if (u.includes('status=queued')) return new Response(JSON.stringify({ total_count: queued }), { status: 200 });
    if (u.includes('status=pending')) return new Response(JSON.stringify({ total_count: pending }), { status: 200 });
    if (u.endsWith('/dispatches')) return new Response(null, { status: dispatchStatus });
    throw new Error('unexpected ' + u);
  };
  try {
    const { POST } = await import('../money-welcome-kick/route.ts');
    const { NextRequest } = await import('next/server');
    const headers = secret === null ? {} : { 'x-kick-secret': secret };
    const res = await POST(new NextRequest('https://broadwayscorecard.com/api/money-welcome-kick', { method: 'POST', headers }));
    return { status: res.status, json: await res.json(), calls };
  } finally {
    globalThis.fetch = realFetch;
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    for (const k of Object.keys(env)) if (env[k] === null) delete process.env[k];
  }
}
const dispatches = (r) => r.calls.filter((c) => c.url.endsWith('/dispatches'));

test('right secret dispatches money-welcome.yml with no inputs', async () => {
  const r = await callRoute({});
  assert.deepEqual([r.status, r.json.acted], [200, true]);
  assert.equal(dispatches(r).length, 1);
  assert.match(dispatches(r)[0].url, /workflows\/money-welcome\.yml\/dispatches$/);
  assert.deepEqual(JSON.parse(dispatches(r)[0].body), { ref: 'main' });
});

test('wrong or missing secret is 401 and touches nothing', async () => {
  for (const secret of ['nope', '', null]) {
    const r = await callRoute({ secret });
    assert.equal(r.status, 401);
    assert.equal(dispatches(r).length, 0);
  }
});

test('queued/pending run skips; GitHub failure is 502; unconfigured is 503', async () => {
  assert.equal(dispatches(await callRoute({ queued: 1 })).length, 0);
  assert.equal(dispatches(await callRoute({ pending: 1 })).length, 0);
  assert.equal((await callRoute({ dispatchStatus: 403 })).status, 502);
  assert.equal((await callRoute({ env: { GH_DISPATCH_TOKEN: null } })).status, 503);
  assert.equal((await callRoute({ dbSecret: null })).status, 401, 'no secret row: nobody authorizes');
  assert.equal((await callRoute({ cfgStatus: 500 })).status, 502);
});

test('cooldown: a second authorized kick inside the window dispatches nothing', async () => {
  const a = await callRoute({ env: { MONEY_WELCOME_KICK_COOLDOWN_MS: '60000' } });
  const b = await callRoute({ env: { MONEY_WELCOME_KICK_COOLDOWN_MS: '60000' } });
  assert.equal(a.json.acted, true);
  assert.deepEqual([b.json.acted, b.json.reason, dispatches(b).length], [false, 'cooldown', 0]);
});
