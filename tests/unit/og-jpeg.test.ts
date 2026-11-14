// Show OG images must ship as small JPEGs: WhatsApp drops link previews whose
// og:image is over ~300 KB and next/og's PNG for a photo was ~1.2 MB
// (2026-09-29, BRO-4395). Imports the REAL helper (CLAUDE.md §15). Registered
// in tests/unit-test-manifest-tsx.txt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { pngToOgJpegResponse } from '../../src/lib/og-jpeg';

// Photo-like fixture: noisy gradient RGBA PNG at OG dimensions.
async function photoLikePng(): Promise<Buffer> {
  const w = 1200, h = 630;
  const raw = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const x = i % w, y = Math.floor(i / w);
    const n = (Math.sin(i * 12.9898) * 43758.5453) % 1;
    raw[i * 4] = (x / w) * 200 + n * 40;
    raw[i * 4 + 1] = (y / h) * 180 + n * 40;
    raw[i * 4 + 2] = 90 + n * 60;
    raw[i * 4 + 3] = 255;
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

test('re-encodes a large PNG to a JPEG under WhatsApp\'s 300 KB limit', async () => {
  const png = await photoLikePng();
  assert.ok(png.length > 300 * 1024, `fixture must start over the limit (${png.length})`);
  const res = await pngToOgJpegResponse(new Response(new Uint8Array(png)));
  const out = Buffer.from(await res.arrayBuffer());
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.deepEqual(Array.from(out.subarray(0, 2)), [0xff, 0xd8], 'JPEG magic bytes');
  assert.ok(out.length < 300 * 1024, `JPEG ${out.length} B must be < 300 KB`);
  const meta = await sharp(out).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.width, 1200);
  assert.equal(meta.height, 630);
});

test('sends a long-lived immutable cache header like ImageResponse', async () => {
  const res = await pngToOgJpegResponse(new Response(new Uint8Array(await photoLikePng())));
  assert.match(res.headers.get('cache-control') || '', /immutable/);
});

test('falls back to the original PNG when the input cannot be re-encoded', async () => {
  const bad = Buffer.from('not an image');
  const res = await pngToOgJpegResponse(new Response(new Uint8Array(bad)));
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), bad);
  assert.doesNotMatch(res.headers.get('cache-control') || '', /immutable/, 'fallback must not be pinned for a year');
});
