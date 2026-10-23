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

// BRO-5990: a small-bytes but over-wide image must still be resized to the display cap.
const { compressImage } = require('./compress-image.js');
const { IMAGE_WIDTH_CAPS, imageRoleFromFilename, exceedsWidthCap } = require('./show-image-caps.js');

test('compressImage resizes an under-byte-limit poster wider than the cap', async () => {
  const buf = await sharp({ create: { width: 800, height: 1200, channels: 3, background: '#336' } }).jpeg({ quality: 40 }).toBuffer();
  assert.ok(buf.length < 60 * 1024);
  const out = await compressImage(buf, 'poster');
  assert.equal((await sharp(out).metadata()).width, IMAGE_WIDTH_CAPS.poster); // the cap, not the 300px byte-limit width
});

test('compressImage leaves an in-cap small poster untouched', async () => {
  const buf = await sharp({ create: { width: 300, height: 450, channels: 3, background: '#336' } }).jpeg().toBuffer();
  assert.equal(await compressImage(buf, 'poster'), buf);
});

test('show-image-caps role + width helpers', () => {
  assert.equal(imageRoleFromFilename('poster.webp'), 'poster');
  assert.equal(imageRoleFromFilename('thumbnail-v2.jpg'), 'thumbnail');
  assert.equal(imageRoleFromFilename('notes.txt'), null);
  assert.equal(exceedsWidthCap('poster', 481), true);
  assert.equal(exceedsWidthCap('poster', 480), false);
  assert.equal(exceedsWidthCap('thumbnail', 541), true);
  assert.equal(exceedsWidthCap('hero', 1920), false);
});

test('placeholder bytes stay byte-identical through compressImage and encodeToCap (exact-MD5 rejection still matches)', async () => {
  const { PLACEHOLDER_FILE_HASHES } = require('./show-images.js');
  const { encodeToCap } = require('./show-image-caps.js');
  const crypto = require('node:crypto');
  const buf = await sharp({ create: { width: 800, height: 1200, channels: 3, background: '#123' } }).webp({ quality: 30 }).toBuffer();
  const h = crypto.createHash('md5').update(buf).digest('hex');
  PLACEHOLDER_FILE_HASHES.add(h);
  try {
    assert.equal(await compressImage(buf, 'poster'), buf);
    assert.equal(await encodeToCap(buf, 'poster', 'webp'), buf);
  } finally { PLACEHOLDER_FILE_HASHES.delete(h); }
});

test('encodeToCap keeps the container format and caps width', async () => {
  const { encodeToCap } = require('./show-image-caps.js');
  const buf = await sharp({ create: { width: 900, height: 900, channels: 3, background: '#a33' } }).jpeg().toBuffer();
  const out = await encodeToCap(buf, 'thumbnail', 'jpg');
  const m = await sharp(out).metadata();
  assert.equal(m.format, 'jpeg');
  assert.equal(m.width, IMAGE_WIDTH_CAPS.thumbnail);
});
