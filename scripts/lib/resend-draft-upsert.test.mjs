// Tests for scripts/lib/resend-draft-upsert.js (BRO-3494, BRO-3493).
// A fake in-memory Resend store stands in for the API; every call goes
// through the real upsertBroadcastDraft / makeResendRequest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  splitBroadcastsByName,
  makeResendRequest,
  upsertBroadcastDraft,
  RESEND_BROADCASTS_URL,
  RESEND_BROADCASTS_LIST_URL,
} = require('./resend-draft-upsert.js');

function fakeResend(initial = []) {
  const store = initial.map((b) => ({ ...b }));
  const calls = [];
  let n = 0;
  async function fetchImpl(url, opt) {
    const method = opt.method;
    const body = opt.body ? JSON.parse(opt.body) : undefined;
    calls.push({ method, url, body });
    const ok = (obj) => ({ ok: true, status: 200, text: async () => JSON.stringify(obj) });
    if (method === 'GET' && url === RESEND_BROADCASTS_LIST_URL) return ok({ data: store });
    if (method === 'POST' && url === RESEND_BROADCASTS_URL) {
      const b = { id: `bc_${++n}`, status: 'draft', ...body };
      store.push(b);
      return ok({ id: b.id });
    }
    if (method === 'PATCH' && url.startsWith(`${RESEND_BROADCASTS_URL}/`)) {
      const id = url.slice(RESEND_BROADCASTS_URL.length + 1);
      const b = store.find((x) => x.id === id);
      Object.assign(b, body);
      return ok({ id });
    }
    if (url.endsWith('/send')) throw new Error('send must never be called');
    return { ok: false, status: 404, text: async () => '{"message":"not found"}' };
  }
  return { store, calls, request: makeResendRequest('re_test', fetchImpl) };
}

const payload = (extra = {}) => ({ audience_id: 'aud', from: 'f@x', subject: 's', html: '<p>x</p>', name: 'BFL weekly 2026-10-12', ...extra });

test('first run creates a draft', async () => {
  const r = fakeResend();
  const out = await upsertBroadcastDraft({ payload: payload(), request: r.request });
  assert.equal(out.action, 'created');
  assert.equal(r.store.length, 1);
});

test('second run for the same week updates the existing draft, no duplicate', async () => {
  const r = fakeResend();
  const first = await upsertBroadcastDraft({ payload: payload(), request: r.request });
  const second = await upsertBroadcastDraft({ payload: payload({ html: '<p>v2</p>' }), request: r.request });
  assert.equal(second.action, 'updated');
  assert.equal(second.id, first.id);
  assert.equal(r.store.length, 1, 'still exactly one broadcast');
  assert.equal(r.store[0].html, '<p>v2</p>');
  assert.equal(r.calls.filter((c) => c.method === 'POST').length, 1);
});

test('a week already sent is refused, nothing created or modified', async () => {
  const r = fakeResend([{ id: 'bc_sent', name: 'BFL weekly 2026-10-12', status: 'sent', html: 'orig' }]);
  const out = await upsertBroadcastDraft({ payload: payload(), request: r.request });
  assert.equal(out.action, 'skipped-sent');
  assert.equal(out.sentStatus, 'sent');
  assert.deepEqual(r.calls.map((c) => c.method), ['GET']);
  assert.equal(r.store[0].html, 'orig');
});

test('by default a cancelled week counts as handled (owner chose not to send)', async () => {
  const r = fakeResend([{ id: 'bc_c', name: 'BFL weekly 2026-10-12', status: 'cancelled' }]);
  const out = await upsertBroadcastDraft({ payload: payload(), request: r.request });
  assert.equal(out.action, 'skipped-sent');
  assert.equal(r.store.length, 1);
});

test('ignoreStatuses opts a status out (opening night re-queues cancelled shows)', async () => {
  const r = fakeResend([{ id: 'bc_c', name: 'BFL weekly 2026-10-12', status: 'cancelled' }]);
  const out = await upsertBroadcastDraft({ payload: payload(), request: r.request, ignoreStatuses: ['cancelled'] });
  assert.equal(out.action, 'created');
});

test('a different week name does not match', async () => {
  const r = fakeResend([{ id: 'old', name: 'BFL weekly 2026-10-05', status: 'sent' }]);
  const out = await upsertBroadcastDraft({ payload: payload(), request: r.request });
  assert.equal(out.action, 'created');
});

test('two drafts with the same name throws instead of guessing', () => {
  assert.throws(() => splitBroadcastsByName({ data: [
    { id: 'a', name: 'N', status: 'draft' }, { id: 'b', name: 'N', status: 'draft' },
  ] }, 'N'), /2 draft broadcasts/);
});

test('missing name is refused (it is the dedup key)', async () => {
  const r = fakeResend();
  await assert.rejects(upsertBroadcastDraft({ payload: { subject: 'x' }, request: r.request }), /payload.name/);
  assert.equal(r.calls.length, 0);
});

test('a failed list call propagates and nothing is created', async () => {
  const request = makeResendRequest('k', async () => ({ ok: false, status: 500, text: async () => 'boom' }));
  await assert.rejects(upsertBroadcastDraft({ payload: payload(), request }), /Resend 500 on GET/);
});
