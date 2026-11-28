/**
 * Batched user_show_stubs lookup (src/lib/diary-show.ts getShowStubsByIds,
 * BRO-4566): a shared diary with many user-added shows makes one request per
 * STUB_BATCH_SIZE ids, never one per show.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getShowStubsByIds, getShowStubById, STUB_BATCH_SIZE } from '../../src/lib/diary-show';

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://db.example';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';

const row = (id: string) => ({ id, title: `T ${id}`, venue: null, city: 'Boston', category: 'us-regional', opening_date: null, poster_url: null });

function fakeFetch(urls: string[], rowsFor: (ids: string[]) => unknown[] | Error = ids => ids.map(row)): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    const list = decodeURIComponent(url.match(/id=in\.([^&]+)/)![1]);
    const ids = list.slice(1, -1).split(',').map(s => JSON.parse(s));
    const rows = rowsFor(ids);
    if (rows instanceof Error) throw rows;
    return new Response(JSON.stringify(rows), { status: 200 });
  }) as typeof fetch;
}

test('5 stub ids → 1 request with an in.() list; non-stub ids never queried', async () => {
  const urls: string[] = [];
  const ids = ['a-us-mz1', 'b-us-mz2', 'c-us-mz3', 'd-us-mz4', 'e-us-mz5', 'wicked-2003', 'a-us-mz1'];
  const out = await getShowStubsByIds(ids, fakeFetch(urls));
  assert.equal(urls.length, 1);
  assert.match(urls[0], /^https:\/\/db\.example\/rest\/v1\/user_show_stubs\?id=in\./);
  assert.deepEqual(Array.from(out.keys()).sort(), ['a-us-mz1', 'b-us-mz2', 'c-us-mz3', 'd-us-mz4', 'e-us-mz5']);
  assert.equal(out.get('a-us-mz1')!.city, 'Boston');
  assert.equal(out.get('a-us-mz1')!.slug, 'a-us-mz1');
});

test('chunks at STUB_BATCH_SIZE; a failed chunk drops only its own ids', async () => {
  const urls: string[] = [];
  const ids = Array.from({ length: STUB_BATCH_SIZE + 3 }, (_, i) => `s${i}-us-mz${i}`);
  const out = await getShowStubsByIds(ids, fakeFetch(urls, chunk => chunk.length === 3 ? new Error('down') : chunk.map(row)));
  assert.equal(urls.length, 2);
  assert.equal(out.size, STUB_BATCH_SIZE);
});

test('rows the server returns for ids not asked for are ignored; quotes never reach the query', async () => {
  const urls: string[] = [];
  const out = await getShowStubsByIds(['ok-mz1', 'bad"x-mz2'], fakeFetch(urls, () => [row('ok-mz1'), row('other-mz9')]));
  assert.deepEqual(Array.from(out.keys()), ['ok-mz1']);
  assert.ok(!decodeURIComponent(urls[0]).includes('bad'));
});

test('nothing to look up → no request', async () => {
  const urls: string[] = [];
  assert.equal((await getShowStubsByIds(['wicked-2003'], fakeFetch(urls))).size, 0);
  assert.equal(urls.length, 0);
});

test('getShowStubById still returns null for a non-stub id', async () => {
  assert.equal(await getShowStubById('wicked-2003'), null);
});
