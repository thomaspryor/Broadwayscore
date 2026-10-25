/**
 * Shared Diary loader (src/lib/shared-diary/load.ts, BRO-4566). The shared
 * outcomes are covered in shared-plans-load.test.ts; this checks the diary's
 * function name and payload shape, above all that a note can't slip through
 * when the owner hasn't turned notes on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSharedDiaryWith } from '../../src/lib/shared-diary/load';
import type { RpcClient } from '../../src/lib/share-links/load';

const TOKEN = 'b'.repeat(32);
const PAYLOAD = {
  name: 'Tom', showText: false, capped: false,
  entries: [{ show_id: 'wicked-2003', date_seen: '2024-11-15', rating: 4.5 }, { show_id: 'x', date_seen: null, rating: 3 }],
};

function client(data: unknown, seen: unknown[] = []): RpcClient {
  return { rpc(fn, args) { seen.push([fn, args]); return Promise.resolve({ data, error: null }); } };
}

test('ok: calls get_shared_diary with the token in the body', async () => {
  const seen: unknown[] = [];
  assert.deepEqual(await loadSharedDiaryWith(TOKEN, client(PAYLOAD, seen)), { status: 'ok', payload: PAYLOAD });
  assert.deepEqual(seen, [['get_shared_diary', { p_token: TOKEN }]]);
});

test('notes come through only when showText is on', async () => {
  const withText = { ...PAYLOAD, entries: [{ ...PAYLOAD.entries[0], text: 'loved it' }] };
  assert.equal((await loadSharedDiaryWith(TOKEN, client(withText))).status, 'unavailable', 'text with showText=false is refused');
  const on = { ...withText, showText: true };
  assert.deepEqual(await loadSharedDiaryWith(TOKEN, client(on)), { status: 'ok', payload: on });
});

test('null is not-shared; malformed payloads are unavailable', async () => {
  assert.deepEqual(await loadSharedDiaryWith(TOKEN, client(null)), { status: 'not-shared' });
  for (const bad of [
    { ...PAYLOAD, capped: undefined },
    { ...PAYLOAD, entries: [{ show_id: 'x', date_seen: null, rating: '4' }] },
    { ...PAYLOAD, entries: [{ show_id: 'x', rating: 4 }] },
    { ...PAYLOAD, showText: 'no' },
  ]) {
    assert.deepEqual(await loadSharedDiaryWith(TOKEN, client(bad)), { status: 'unavailable' }, JSON.stringify(bad));
  }
});

test('malformed token never reaches the database', async () => {
  const seen: unknown[] = [];
  assert.deepEqual(await loadSharedDiaryWith('nope', client(PAYLOAD, seen)), { status: 'not-shared' });
  assert.equal(seen.length, 0);
});
