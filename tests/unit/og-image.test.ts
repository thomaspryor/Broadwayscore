import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { fetchImageDataUri } from '../../src/lib/og-image';

test('optimizer WebP pass-through is converted to a Satori-compatible JPEG', async t => {
  const webp = await sharp({ create: { width: 40, height: 20, channels: 3, background: 'red' } }).webp().toBuffer();
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array(webp), { headers: { 'content-type': 'image/webp' } }));
  const uri = await fetchImageDataUri('/images/shows/operation-mincemeat-west-end-2024/hero.webp', 20);
  assert.match(uri!, /^data:image\/jpeg;base64,/);
  const meta = await sharp(Buffer.from(uri!.split(',')[1], 'base64')).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.width, 20);
  assert.equal(meta.height, 10);
  assert.equal(fetchMock.mock.calls.length, 1, 'conversion makes no extra fetch');
  const options = fetchMock.mock.calls[0].arguments[1] as RequestInit;
  assert.deepEqual(options.headers, { Accept: 'image/jpeg,image/png' });
});

for (const format of ['jpeg', 'png'] as const) {
  test(`${format} responses keep their original bytes`, async t => {
    const bytes = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'blue' } })[format]().toBuffer();
    t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array(bytes), { headers: { 'content-type': `image/${format}; charset=binary` } }));
    const uri = await fetchImageDataUri('/images/shows/hamilton-2015/hero.webp', 1200);
    assert.equal(uri, `data:image/${format};base64,${bytes.toString('base64')}`);
  });
}

test('HTTP failures, unsupported formats, and corrupt WebP return null', async t => {
  for (const response of [new Response('missing', { status: 400 }), new Response('svg', { headers: { 'content-type': 'image/svg+xml' } }), new Response('bad webp', { headers: { 'content-type': 'image/webp' } })]) {
    const mock = t.mock.method(globalThis, 'fetch', async () => response);
    assert.equal(await fetchImageDataUri('/images/shows/show/hero.webp', 1200), null);
    mock.mock.restore();
  }
});

test('remote and traversal paths never reach the optimizer', async t => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('must not fetch'); });
  for (const image of ['https://example.com/image.webp', '//example.com/image.webp', '/images/../private.webp']) {
    assert.equal(await fetchImageDataUri(image, 1200), null);
  }
  assert.equal(fetchMock.mock.calls.length, 0);
});
