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

test('transient failures (thrown fetch, 429, 503) are retried; a dead pointer (404) is not', async t => {
  const bytes = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'green' } }).jpeg().toBuffer();
  const ok = () => new Response(new Uint8Array(bytes), { headers: { 'content-type': 'image/jpeg' } });
  const steps: Array<() => Response> = [
    () => { throw new TypeError('fetch failed'); },
    () => new Response('slow down', { status: 429 }),
    ok,
  ];
  let i = 0;
  const flaky = t.mock.method(globalThis, 'fetch', async () => steps[i++]());
  const uri = await fetchImageDataUri('/images/shows/a/hero.webp', 1200, { retryDelayMs: 1 });
  assert.equal(uri, `data:image/jpeg;base64,${bytes.toString('base64')}`);
  assert.equal(flaky.mock.calls.length, 3);
  flaky.mock.restore();

  const unavailable = t.mock.method(globalThis, 'fetch', async () => new Response('down', { status: 503 }));
  assert.equal(await fetchImageDataUri('/images/shows/a/hero.webp', 1200, { retryDelayMs: 1 }), null);
  assert.equal(unavailable.mock.calls.length, 3, 'gives up after 3 attempts');
  unavailable.mock.restore();

  const missing = t.mock.method(globalThis, 'fetch', async () => new Response('nope', { status: 404 }));
  assert.equal(await fetchImageDataUri('/images/shows/a/hero.webp', 1200, { retryDelayMs: 1 }), null);
  assert.equal(missing.mock.calls.length, 1, '404 is not retried');
});

test('a fetch that always throws returns null after 3 attempts, 500 is retried, no sleep after the last attempt', async t => {
  const thrower = t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('fetch failed'); });
  const started = Date.now();
  assert.equal(await fetchImageDataUri('/images/shows/a/hero.webp', 1200, { retryDelayMs: 50 }), null);
  assert.equal(thrower.mock.calls.length, 3);
  assert.ok(Date.now() - started < 50 + 100 + 90, 'sleeps only between attempts (50 + 100 ms), not after the third');
  thrower.mock.restore();

  const server = t.mock.method(globalThis, 'fetch', async () => new Response('boom', { status: 500 }));
  assert.equal(await fetchImageDataUri('/images/shows/a/hero.webp', 1200, { retryDelayMs: 1 }), null);
  assert.equal(server.mock.calls.length, 3);
  const options = server.mock.calls[0].arguments[1] as RequestInit;
  assert.ok(options.signal, 'each attempt has a timeout signal');
});

test('versioned show art (?v=<hash>) reaches the optimizer as a bare path', async t => {
  const bytes = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } }).jpeg().toBuffer();
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array(bytes), { headers: { 'content-type': 'image/jpeg' } }));
  const uri = await fetchImageDataUri('/images/shows/i-became-we-off-broadway-2026/poster.jpg?v=abcd1234#frag', 1200);
  assert.equal(uri, `data:image/jpeg;base64,${bytes.toString('base64')}`);
  const requested = new URL(String(fetchMock.mock.calls[0].arguments[0]));
  assert.equal(requested.pathname, '/_next/image');
  assert.equal(requested.searchParams.get('url'), '/images/shows/i-became-we-off-broadway-2026/poster.jpg');
});
