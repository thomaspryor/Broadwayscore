import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sharp = require('sharp');
const { ensureThumbnailAspect } = require('./compress-image.js');

const mk = (w, h) => sharp({ create: { width: w, height: h, channels: 3, background: '#c33' } }).jpeg().toBuffer();

test('landscape 640x427 (BRO-5417) is cropped to a square that passes check-image-aspect', async () => {
  const out = await ensureThumbnailAspect(await mk(640, 427));
  const m = await sharp(out).metadata();
  assert.equal(m.width, 427);
  assert.equal(m.height, 427);
  assert.ok(m.height / m.width >= 0.85);
});

test('square and portrait buffers pass through untouched', async () => {
  for (const [w, h] of [[400, 400], [300, 450]]) {
    const b = await mk(w, h);
    assert.equal(await ensureThumbnailAspect(b), b);
  }
});

test('unreadable buffer is returned as-is', async () => {
  const b = Buffer.from('not an image');
  assert.equal(await ensureThumbnailAspect(b), b);
});

test('over-tall 200x600 banner is cropped into the 0.85..1.70 band', async () => {
  const m = await sharp(await ensureThumbnailAspect(await mk(200, 600))).metadata();
  assert.ok(m.height / m.width <= 1.7 && m.height / m.width >= 0.85);
});
