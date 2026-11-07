import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const unregister = require('tsx/cjs/api').register();
after(unregister);
const sharp = require('sharp');
const scoreCards = require('../../src/components/show-cards/ScoreBadge.tsx');

test('show OG renders complete posters while preserving hero and fallback layouts', async t => {
  // Color bands make cropping observable in the real Satori/JPEG output.
  const poster = await sharp({ create: { width: 480, height: 757, channels: 3, background: 'green' } })
    .composite([
      { input: await sharp({ create: { width: 480, height: 100, channels: 3, background: 'red' } }).png().toBuffer(), top: 0, left: 0 },
      { input: await sharp({ create: { width: 480, height: 100, channels: 3, background: 'blue' } }).png().toBuffer(), top: 657, left: 0 },
    ]).png().toBuffer();
  const hero = await sharp({ create: { width: 1200, height: 400, channels: 3, background: 'yellow' } }).png().toBuffer();
  let show;
  const originalLoad = Module._load;
  t.mock.method(Module, '_load', function (id, ...args) {
    if (id === '@/lib/data-core') return { getShowBySlug: () => show };
    if (id === '@/components/show-cards') return scoreCards;
    return originalLoad.call(this, id, ...args);
  });
  const requested = [];
  t.mock.method(globalThis, 'fetch', async url => {
    const parsed = new URL(url);
    if (parsed.pathname !== '/_next/image') return new Response('', { status: 503 });
    const image = parsed.searchParams.get('url');
    requested.push(image);
    return new Response(image === '/images/hero.png' ? hero : poster, { headers: { 'content-type': 'image/png' } });
  });
  const OGImage = require('../../src/app/show/[slug]/opengraph-image.tsx').default;
  async function render(images, status = 'open') {
    show = { id: 'test', category: 'broadway', status, images,
      criticScore: { score: 78, reviewCount: 12, tier1Count: 3, tier2Count: 4 } };
    const response = await OGImage({ params: Promise.resolve({ slug: 'test' }) });
    assert.equal(response.headers.get('content-type'), 'image/jpeg');
    const { data, info } = await sharp(Buffer.from(await response.arrayBuffer())).raw().toBuffer({ resolveWithObject: true });
    assert.equal(info.width, 1200);
    assert.equal(info.height, 630);
    return (x, y) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
  }
  function color(pixel, expected, label) {
    assert.ok(pixel.every((value, i) => Math.abs(value - expected[i]) < 12), `${label}: got ${pixel}, expected ${expected}`);
  }

  await t.test('poster-only art retains both ends and is centered beside the score badge', async () => {
    const pixel = await render({ poster: '/images/poster.png', hero: null });
    color(pixel(600, 30), [255, 0, 0], 'poster top remains visible');
    color(pixel(600, 600), [0, 0, 255], 'poster bottom remains visible');
    color(pixel(200, 315), [15, 15, 20], 'left margin');
    color(pixel(1000, 315), [15, 15, 20], 'right margin');
    color(pixel(1040, 510), [34, 197, 94], 'score badge');
  });
  await t.test('hero wins over the poster and still fills the card', async () => {
    const pixel = await render({ hero: '/images/hero.png', poster: '/images/poster.png' });
    assert.equal(requested.at(-1), '/images/hero.png');
    color(pixel(600, 30), [255, 255, 0], 'hero fills the top');
    color(pixel(200, 315), [255, 255, 0], 'hero fills the side');
  });
  await t.test('posters without a published score stay contained with no badge', async () => {
    const pixel = await render({ poster: '/images/poster.png' }, 'previews');
    color(pixel(600, 30), [255, 0, 0], 'poster top remains visible');
    color(pixel(1040, 510), [15, 15, 20], 'no score badge');
  });
  await t.test('missing art uses the existing fallback without fetching an image', async () => {
    const count = requested.length;
    const pixel = await render({});
    assert.equal(requested.length, count);
    color(pixel(600, 30), [15, 15, 20], 'fallback background');
  });
});
