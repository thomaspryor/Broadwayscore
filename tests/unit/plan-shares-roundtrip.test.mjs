// Unit tests for scripts/lib/plan-shares-roundtrip.mjs (BRO-4481).
// The real run needs live Supabase credentials (CI only), so this drives the
// same check sequence against a small fake PostgREST: a well-behaved server
// must pass every check, and each kind of server bug must fail one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPlanSharesChecks, payloadProblems, isMissingRelation } from '../../scripts/lib/plan-shares-roundtrip.mjs';

const ANON = 'anon-key';
const A = { id: 'aaaaaaaa-0000-0000-0000-000000000000' };
const TOKEN_A = 'jwt-a';
const TOKEN_B = 'jwt-b';
const PAST_SHOW = 'hamilton-2015';

function hex32() {
  return Array.from({ length: 32 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
}
const res = (status, json) => ({ status, ok: status >= 200 && status < 300, json, text: JSON.stringify(json) });

/** Fake PostgREST + the migration's semantics. `bugs` switches individual ones off. */
function fakeServer(bugs = {}) {
  let share = null;
  const watch = [{ show_id: PAST_SHOW, planned_date: '2026-09-11', curtain_time: '20:00:00' }];
  const calls = [];
  const rest = async (method, path, token, body) => {
    calls.push(`${method} ${path.split('?')[0]}`);
    if (bugs.missing && path.startsWith('plan_shares')) return { status: 404, ok: false, json: null, text: '{"code":"PGRST205"}' };
    if (path.startsWith('watchlist')) { watch.push({ curtain_time: null, ...body }); return res(201, [body]); }
    if (path.startsWith('plan_shares')) {
      if (token === ANON) return res(401, { code: '42501', message: 'permission denied' });
      const mine = token === TOKEN_A;
      if (method === 'POST' && share && path.includes('on_conflict=user_id')) {
        if (bugs.upsertRotates) share.token = hex32();
        Object.assign(share, { display_name: body.display_name, show_booked: body.show_booked, show_unbooked: body.show_unbooked });
        return res(201, [share]);
      }
      if (method === 'POST') {
        share = { user_id: body.user_id, display_name: body.display_name.trim(), token: bugs.keepClientToken ? body.token : hex32(), enabled: true };
        return res(201, [share]);
      }
      if (method === 'GET') return res(200, share && (mine || bugs.leakToB) ? [share] : []);
      if (method === 'PATCH') {
        if (bugs.patchErrors && mine && body.token) return res(400, { message: 'boom' });
        if (!mine && !bugs.leakToB) return res(200, []);
        const { token: t, ...rest2 } = body;
        Object.assign(share, rest2, bugs.tokenWritable && t ? { token: t } : {});
        return res(200, [share]);
      }
      if (method === 'DELETE') { share = null; return res(204, null); }
    }
    if (path.startsWith('rpc/get_shared_plans?')) {
      return bugs.getAllowed ? res(200, null) : res(405, { code: 'PGRST101' });
    }
    if (path === 'rpc/get_shared_plans') {
      if (!share || !share.enabled || body.p_token !== share.token) return res(200, null);
      const entries = watch
        .filter(w => bugs.leakPast || w.show_id !== PAST_SHOW)
        .map(w => (bugs.leakTime
          ? { show_id: w.show_id, planned_date: w.planned_date ?? null, logged: false, curtain_time: w.curtain_time }
          : { show_id: w.show_id, planned_date: w.planned_date ?? null, logged: false }));
      return res(200, { name: share.display_name, showBooked: true, showUnbooked: true, entries });
    }
    if (path === 'rpc/rotate_plan_share_token') {
      if (token === ANON && !bugs.anonRotate) return res(401, { code: '42501' });
      share.token = hex32();
      return res(200, share.token);
    }
    throw new Error(`fake server: unhandled ${method} ${path}`);
  };
  return { rest, calls };
}

async function run(bugs) {
  const results = [];
  const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); return ok; };
  const { rest, calls } = fakeServer(bugs);
  const out = await runPlanSharesChecks({
    rest, check, anonKey: ANON, userA: A, tokenA: TOKEN_A, tokenB: TOKEN_B,
    pastUnloggedShowId: PAST_SHOW, now: new Date('2026-10-01T12:00:00Z'),
  });
  return { out, results, failed: results.filter(r => !r.ok).map(r => r.name), calls };
}

test('a correct server passes every check', async () => {
  const { out, results, failed } = await run({});
  assert.equal(out.skipped, false);
  assert.ok(results.length >= 16, `expected the full sequence, got ${results.length}`);
  assert.deepEqual(failed, []);
});

test('skips cleanly before the migration is applied', async () => {
  const { out, results, calls } = await run({ missing: true });
  assert.equal(out.skipped, true);
  assert.equal(results.length, 0);
  assert.deepEqual(calls, ['GET plan_shares']);
});

for (const [bug, expectFail] of [
  ['keepClientToken', 'plans: server mints the token (client value ignored)'],
  ['tokenWritable', 'plans: owner cannot overwrite the token'],
  ['leakToB', 'plans: RLS hides the share from another user'],
  ['leakTime', 'plans: payload carries only the allowed fields'],
  ['leakPast', 'plans: a past, unlogged plan stays private'],
  ['anonRotate', 'plans: anonymous cannot rotate'],
  ['upsertRotates', 'plans: client upsert succeeds and keeps the token'],
  ['patchErrors', 'plans: owner cannot overwrite the token'],
  ['getAllowed', 'plans: GET on get_shared_plans is refused (token stays out of URLs)'],
]) {
  test(`server bug "${bug}" is caught`, async () => {
    const { failed } = await run({ [bug]: true });
    assert.ok(failed.includes(expectFail), `expected "${expectFail}" to fail; failed=${JSON.stringify(failed)}`);
  });
}

test('payloadProblems flags extra keys and forbidden text', () => {
  const clean = { name: 'T', showBooked: true, showUnbooked: true, entries: [{ show_id: 'x', planned_date: null, logged: false }] };
  assert.deepEqual(payloadProblems(clean), []);
  assert.match(payloadProblems({ ...clean, user_id: 'u' })[0], /top-level keys/);
  assert.match(payloadProblems({ ...clean, entries: [{ ...clean.entries[0], curtain_time: '19:30' }] })[0], /entry keys/);
  assert.match(payloadProblems(clean, { forbiddenText: ['"T"'] })[0], /contains/);
  assert.deepEqual(payloadProblems(null), ['payload is not an object']);
});

test('isMissingRelation recognises PostgREST schema-cache misses', () => {
  assert.ok(isMissingRelation({ status: 404, text: '' }));
  assert.ok(isMissingRelation({ status: 400, text: '{"code":"PGRST205","message":"Could not find the table"}' }));
  assert.ok(!isMissingRelation({ status: 401, text: '{"code":"42501"}' }));
});
