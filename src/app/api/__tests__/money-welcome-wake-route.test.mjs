/**
 * BRO-7704: the real /api/money-welcome-wake POST handler. Only global fetch is stubbed.
 * Run: npx tsx --test src/app/api/__tests__/money-welcome-wake-route.test.mjs
 */
import { register } from 'node:module';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
register('./next-subpath-loader.mjs', import.meta.url);

async function callRoute({ rows, queued = 0, pending = 0, dispatchStatus = 204, env = {} }) {
  const saved = { ...process.env };
  Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: 'https://db.test', SUPABASE_SERVICE_ROLE_KEY: 'svc', GH_DISPATCH_TOKEN: 'gh', MONEY_WELCOME_WAKE_COOLDOWN_MS: '0', ...env });
  for (const k of Object.keys(env)) if (env[k] === null) delete process.env[k];
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method || 'GET', body: init.body });
    if (u.includes('/rest/v1/money_scorecard_signups')) return new Response(JSON.stringify(rows), { status: 200 });
    if (u.includes('status=queued')) return new Response(JSON.stringify({ total_count: queued }), { status: 200 });
    if (u.includes('status=pending')) return new Response(JSON.stringify({ total_count: pending }), { status: 200 });
    if (u.endsWith('/dispatches')) return new Response(null, { status: dispatchStatus });
    throw new Error('unexpected ' + u);
  };
  try {
    const { POST } = await import('../money-welcome-wake/route.ts');
    const { NextRequest } = await import('next/server');
    const res = await POST(new NextRequest('https://broadwayscorecard.com/api/money-welcome-wake', { method: 'POST' }));
    return { status: res.status, json: await res.json(), calls };
  } finally {
    globalThis.fetch = realFetch;
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    for (const k of Object.keys(env)) if (env[k] === null) delete process.env[k];
  }
}
const dispatches = (r) => r.calls.filter((c) => c.url.endsWith('/dispatches'));
const fresh = () => [{ created_at: new Date(Date.now() - 60000).toISOString(), welcomed_at: null, unsubscribed_at: null }];

test('route: a fresh waiting row dispatches money-welcome.yml with no inputs', async () => {
  const r = await callRoute({ rows: fresh() });
  assert.deepEqual([r.status, r.json.acted], [200, true]);
  const d = dispatches(r);
  assert.equal(d.length, 1);
  assert.match(d[0].url, /actions\/workflows\/money-welcome\.yml\/dispatches$/);
  assert.deepEqual(JSON.parse(d[0].body), { ref: 'main' }, 'no inputs: a real pass, never a preview send');
});

test('route: nothing waiting, or a run already queued or pending, dispatches nothing', async () => {
  assert.equal(dispatches(await callRoute({ rows: [] })).length, 0);
  const q = await callRoute({ rows: fresh(), queued: 1 });
  assert.deepEqual([q.json.acted, q.json.reason], [false, 'run-already-queued']);
  assert.equal(dispatches(q).length, 0);
  assert.equal(dispatches(await callRoute({ rows: fresh(), pending: 1 })).length, 0);
});

test('route: GitHub failure is a 502, missing config does nothing', async () => {
  assert.equal((await callRoute({ rows: fresh(), dispatchStatus: 403 })).status, 502);
  const r = await callRoute({ rows: fresh(), env: { GH_DISPATCH_TOKEN: null } });
  assert.deepEqual([r.json.ok, r.json.reason, dispatches(r).length], [false, 'not-configured', 0]);
});

test('route: a failed dispatch does not arm the cooldown, so the next kick still goes through', async () => {
  const env = { MONEY_WELCOME_WAKE_COOLDOWN_MS: '300' };
  const failed = await callRoute({ rows: fresh(), dispatchStatus: 403, env });
  assert.equal(failed.status, 502);
  const retry = await callRoute({ rows: fresh(), env });
  assert.equal(retry.json.acted, true, 'a 502 must not swallow the next real sign-up kick');
  await new Promise((r) => setTimeout(r, 400)); // let this short cooldown lapse before the next test
});

test('route: a burst of calls inside the cooldown touches Supabase and GitHub once', async () => {
  const env = { MONEY_WELCOME_WAKE_COOLDOWN_MS: '300' };
  const idle = await callRoute({ rows: [], env }); // nothing waiting: must not start the cooldown
  assert.equal(idle.json.reason, 'nothing-waiting');
  const first = await callRoute({ rows: fresh(), env });
  const second = await callRoute({ rows: fresh(), env });
  assert.equal(first.json.acted, true, 'an idle call before it must not have swallowed the kick (BRO-7704 probe)');
  assert.deepEqual([second.json.acted, second.json.reason, second.calls.length], [false, 'cooldown', 1]); // only the Supabase read, no GitHub call
});

test('route and client carry no secrets and send no body', () => {
  const route = fs.readFileSync(new URL('../money-welcome-wake/route.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(route, /req\.(json|text|formData)|inputs\s*:/, 'the request body is never read and no workflow inputs are sent');
});

