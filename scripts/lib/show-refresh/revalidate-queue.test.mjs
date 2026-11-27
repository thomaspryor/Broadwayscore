// BRO-8410: failed show-refresh revalidations are queued, retried and drained.
// Run: npx tsx --test scripts/publish-show-refresh.test.mjs  (also: node --test this file)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const q = require('./revalidate-queue.js');
const store = require('./store.js');

const NOW = Date.UTC(2026, 10, 27, 12, 0);
const env = { SHOW_REFRESH_REVALIDATE_SECRET: 's', SHOW_REFRESH_SITE: 'https://example.invalid' };
const P = store.PATHS.revalidatePending;

function fakeStorage() {
  const objs = new Map();
  return {
    objs,
    async get(path) { return objs.has(path) ? { status: 200, text: objs.get(path) } : { status: 404, text: '' }; },
    async put(path, text) { objs.set(path, text); },
  };
}
const fetchOf = (...statuses) => { const calls = []; let i = 0; const f = async (_u, init) => { calls.push(JSON.parse(init.body).slugs); const s = statuses[Math.min(i++, statuses.length - 1)]; if (s === 'throw') throw new Error('boom'); return new Response('', { status: s }); }; f.calls = calls; return f; };
const stored = (st) => JSON.parse(st.objs.get(P) || '{"entries":{}}').entries;
const quiet = async (fn) => { const { log } = console; console.log = () => {}; try { return await fn(); } finally { console.log = log; } };
const run = (o) => quiet(() => q.revalidateWithQueue({ env, now: NOW, ...o }));

test('a failed revalidation is queued', async () => {
  const st = fakeStorage();
  const r = await run({ storage: st, newSlugs: ['a', 'b'], fetchImpl: fetchOf(503) });
  assert.deepEqual(Object.keys(stored(st)).sort(), ['a', 'b']);
  assert.equal(stored(st).a.attempts, 1);
  assert.deepEqual(r.pending.sort(), ['a', 'b']);
});

test('a thrown fetch is queued too', async () => {
  const st = fakeStorage();
  await run({ storage: st, newSlugs: ['a'], fetchImpl: fetchOf('throw') });
  assert.deepEqual(Object.keys(stored(st)), ['a']);
});

test('the next run retries the queue alongside its own slugs and drains it on success', async () => {
  const st = fakeStorage();
  await run({ storage: st, newSlugs: ['a'], fetchImpl: fetchOf(503) });
  const f = fetchOf(200);
  const r = await run({ storage: st, newSlugs: ['c'], now: NOW + 600000, fetchImpl: f });
  assert.deepEqual(f.calls[0].sort(), ['a', 'c']);
  assert.deepEqual(r.retried, ['a']);
  assert.deepEqual(stored(st), {});
  assert.deepEqual(r.pending, []);
});

test('a run with nothing of its own still drains the queue', async () => {
  const st = fakeStorage();
  await run({ storage: st, newSlugs: ['a'], fetchImpl: fetchOf(500) });
  const f = fetchOf(200);
  await run({ storage: st, newSlugs: [], now: NOW + 1, fetchImpl: f });
  assert.deepEqual(f.calls, [['a']]);
  assert.deepEqual(stored(st), {});
});

test('repeated failure is retried up to the cap, then abandoned with the queue emptied', async () => {
  const st = fakeStorage();
  const f = fetchOf(500);
  let r;
  for (let i = 0; i < q.MAX_ATTEMPTS; i++) {
    assert.equal(Object.keys(stored(st)).length, i === 0 ? 0 : 1, `before try ${i + 1}`);
    r = await run({ storage: st, newSlugs: i === 0 ? ['a'] : [], now: NOW + i * 600000, fetchImpl: f });
  }
  assert.equal(f.calls.length, q.MAX_ATTEMPTS);
  assert.deepEqual(r.abandoned, ['a']);
  assert.deepEqual(stored(st), {});
  const after = await run({ storage: st, newSlugs: [], now: NOW + 99 * 600000, fetchImpl: f });
  assert.equal(f.calls.length, q.MAX_ATTEMPTS, 'no further attempts once abandoned');
  assert.equal(after.message, 'skipped (no slugs)');
});

test('an entry older than the age cap is dropped without a retry', async () => {
  const st = fakeStorage();
  await run({ storage: st, newSlugs: ['a'], fetchImpl: fetchOf(500) });
  const f = fetchOf(200);
  const r = await run({ storage: st, newSlugs: [], now: NOW + q.MAX_AGE_MS + 1, fetchImpl: f });
  assert.equal(f.calls.length, 0);
  assert.deepEqual(r.abandoned, ['a']);
  assert.deepEqual(stored(st), {});
});

test('success leaves an empty queue and writes nothing', async () => {
  const st = fakeStorage();
  const r = await run({ storage: st, newSlugs: ['a'], fetchImpl: fetchOf(200) });
  assert.equal(st.objs.has(P), false);
  assert.deepEqual(r.pending, []);
});

test('reader off / no secret: skipped, queue untouched, no fetch', async () => {
  const st = fakeStorage();
  st.objs.set(P, JSON.stringify({ schema: 1, entries: { a: { firstFailedAt: NOW, attempts: 2, lastError: '' } } }));
  const f = fetchOf(200);
  const r = await quiet(() => q.revalidateWithQueue({ env: {}, storage: st, newSlugs: ['b'], now: NOW, fetchImpl: f }));
  assert.match(r.message, /skipped \(SHOW_REFRESH_REVALIDATE_SECRET unset\)/);
  assert.equal(f.calls.length, 0);
  assert.equal(stored(st).a.attempts, 2);
});

test('an unreadable queue is never overwritten; this run still revalidates', async () => {
  const st = fakeStorage();
  st.get = async () => ({ status: 500, text: 'down' });
  const f = fetchOf(500);
  const r = await run({ storage: st, newSlugs: ['a'], fetchImpl: f });
  assert.equal(f.calls.length, 1);
  assert.equal(st.objs.has(P), false);
  assert.match(r.queueNote, /read failed/);
});

test('no queue store behaves as before: one call, nothing persisted', async () => {
  const f = fetchOf(200);
  const r = await run({ storage: null, newSlugs: ['a'], fetchImpl: f });
  assert.equal(f.calls.length, 1);
  assert.match(r.message, /HTTP 200 for 1 show/);
});

test('parseQueue tolerates junk', () => {
  assert.deepEqual(q.parseQueue(null), q.emptyQueue());
  assert.deepEqual(q.parseQueue({ entries: { a: 5, b: { firstFailedAt: 'x' } } }), q.emptyQueue());
});
