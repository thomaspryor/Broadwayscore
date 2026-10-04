// Unit tests for scripts/lib/diary-shares-roundtrip.mjs (BRO-4566).
// The real run needs live Supabase credentials (CI only), so this drives the
// same sequence against a fake PostgREST: a well-behaved server passes every
// check, and each kind of server bug fails one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDiarySharesChecks, diaryPayloadProblems } from '../../scripts/lib/diary-shares-roundtrip.mjs';

const ANON = 'anon-key';
const A = { id: 'aaaaaaaa-0000-0000-0000-000000000000' };
const TOKEN_A = 'jwt-a';
const TOKEN_B = 'jwt-b';
const SHOW = 'hamilton-2015';
const NOTE = 'edited note';

function hex32() {
  return Array.from({ length: 32 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');
}
const res = (status, json) => ({ status, ok: status >= 200 && status < 300, json, text: JSON.stringify(json) });

function fakeServer(bugs = {}) {
  let share = null;
  const reviews = [];
  const calls = [];
  const rest = async (method, path, token, body) => {
    calls.push(`${method} ${path.split('?')[0]}`);
    if (bugs.missing && path.startsWith('diary_shares')) return { status: 404, ok: false, json: null, text: '{"code":"PGRST205"}' };
    if (path.startsWith('reviews')) {
      if (method === 'POST') { const r = { id: 'rev-future', ...body }; reviews.push(r); return res(201, [r]); }
      if (method === 'DELETE') { reviews.length = 0; return res(204, null); }
    }
    if (path.startsWith('diary_shares')) {
      if (token === ANON) return res(401, { code: '42501' });
      const mine = token === TOKEN_A;
      if (method === 'POST') {
        share = { user_id: body.user_id, display_name: body.display_name.trim(), token: bugs.keepClientToken ? body.token : hex32(), enabled: true, show_text: !!bugs.textOnByDefault };
        return res(201, [share]);
      }
      if (method === 'GET') return res(200, share && (mine || bugs.leakToB) ? [share] : []);
      if (method === 'PATCH') {
        if (!mine && !bugs.leakToB) return res(200, []);
        if (bugs.notesPatchFails && body.show_text) return res(403, { message: 'denied' });
        const { token: t, ...rest2 } = body;
        Object.assign(share, rest2, bugs.tokenWritable && t ? { token: t } : {});
        return res(200, [share]);
      }
      if (method === 'DELETE') { share = null; return res(204, null); }
    }
    if (path.startsWith('rpc/get_shared_diary?')) return bugs.getAllowed ? res(200, null) : res(405, { code: 'PGRST101' });
    if (path === 'rpc/get_shared_diary') {
      if (!share || !share.enabled || body.p_token !== share.token) return res(200, null);
      const e = { show_id: SHOW, date_seen: '2024-11-15', rating: 5 };
      if (share.show_text || bugs.leakText) e.text = NOTE;
      if (bugs.leakUser) e.user_id = A.id;
      const entries = [e];
      if (bugs.leakFuture) for (const r of reviews) entries.push({ show_id: r.show_id, date_seen: r.date_seen, rating: r.rating });
      return res(200, { name: share.display_name, showText: share.show_text, capped: false, entries });
    }
    if (path === 'rpc/rotate_diary_share_token') {
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
  const out = await runDiarySharesChecks({ rest, check, anonKey: ANON, userA: A, tokenA: TOKEN_A, tokenB: TOKEN_B, showId: SHOW, noteText: NOTE });
  return { out, results, failed: results.filter(r => !r.ok).map(r => r.name), calls };
}

test('a correct server passes every check', async () => {
  const { out, results, failed } = await run({});
  assert.equal(out.skipped, false);
  assert.ok(results.length >= 19, `expected the full sequence, got ${results.length}`);
  assert.deepEqual(failed, []);
});

test('skips cleanly before the migration is applied', async () => {
  const { out, results, calls } = await run({ missing: true });
  assert.equal(out.skipped, true);
  assert.equal(results.length, 0);
  assert.deepEqual(calls, ['GET diary_shares']);
  assert.ok(!calls.includes('POST reviews'), 'nothing is written before the migration exists');
});

for (const [bug, expectFail] of [
  ['keepClientToken', 'diary: server mints the token (client value ignored)'],
  ['textOnByDefault', 'diary: notes are off by default'],
  ['tokenWritable', 'diary: owner cannot overwrite the token'],
  ['leakToB', 'diary: RLS hides the share from another user'],
  ['leakText', 'diary: with notes off, no note text and only the allowed fields'],
  ['leakUser', 'diary: with notes off, no note text and only the allowed fields'],
  ['getAllowed', 'diary: GET on get_shared_diary is refused (token stays out of URLs)'],
  ['anonRotate', 'diary: anonymous cannot rotate'],
  ['leakFuture', 'diary: a future-dated review (a plan) is not listed'],
  ['notesPatchFails', 'diary: owner can turn notes on'],
]) {
  test(`server bug "${bug}" is caught`, async () => {
    const { failed } = await run({ [bug]: true });
    assert.ok(failed.includes(expectFail), `expected "${expectFail}" to fail; failed=${JSON.stringify(failed)}`);
  });
}

test('diaryPayloadProblems allows text only when asked', () => {
  const clean = { name: 'T', showText: false, capped: false, entries: [{ show_id: 'x', date_seen: null, rating: 4 }] };
  assert.deepEqual(diaryPayloadProblems(clean), []);
  const withText = { ...clean, entries: [{ ...clean.entries[0], text: 'hi' }] };
  assert.match(diaryPayloadProblems(withText)[0], /entry keys/);
  assert.deepEqual(diaryPayloadProblems(withText, { allowText: true }), []);
  assert.match(diaryPayloadProblems({ ...clean, user_id: 'u' })[0], /top-level keys/);
});
