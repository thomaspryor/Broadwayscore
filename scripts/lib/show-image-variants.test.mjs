import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const sharp = require('sharp');
const caps = require('./show-image-caps.js');

const tsSrc = fs.readFileSync(new URL('../../src/lib/images.ts', import.meta.url), 'utf8');

test('src/lib/images.ts variant widths and original caps mirror show-image-caps.js', () => {
  const v = /VARIANT_WIDTHS = \{ poster: (\d+), thumbnail: (\d+) \}/.exec(tsSrc);
  assert.equal(Number(v[1]), caps.VARIANT_WIDTHS.poster);
  assert.equal(Number(v[2]), caps.VARIANT_WIDTHS.thumbnail);
  const o = /ORIGINAL_WIDTH_CAPS = \{ poster: (\d+), thumbnail: (\d+) \}/.exec(tsSrc);
  assert.equal(Number(o[1]), caps.IMAGE_WIDTH_CAPS.poster);
  assert.equal(Number(o[2]), caps.IMAGE_WIDTH_CAPS.thumbnail);
  assert.ok(tsSrc.includes(`/sm/`) && caps.VARIANT_DIR === 'sm');
});

test('variantPathFor maps canonical poster/thumbnail to sm/<role>.webp, ignores everything else', () => {
  assert.equal(caps.variantPathFor('/x/show/poster.jpg'), path.join('/x/show', 'sm', 'poster.webp'));
  assert.equal(caps.variantPathFor('/x/show/thumbnail.png'), path.join('/x/show', 'sm', 'thumbnail.webp'));
  assert.equal(caps.variantPathFor('/x/show/hero.webp'), null);
  assert.equal(caps.variantPathFor('/x/show/thumbnail-v2.webp'), null);
});

test('writeVariant shrinks to the role width, never enlarges, is idempotent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'variants-'));
  const big = path.join(dir, 'thumbnail.webp');
  fs.writeFileSync(big, await sharp({ create: { width: 540, height: 540, channels: 3, background: '#39c' } }).webp().toBuffer());
  assert.equal(await caps.writeVariant(big), 'written');
  assert.equal((await sharp(path.join(dir, 'sm', 'thumbnail.webp')).metadata()).width, caps.VARIANT_WIDTHS.thumbnail);
  assert.equal(await caps.writeVariant(big), 'skipped');
  const tiny = path.join(dir, 'poster.jpg');
  fs.writeFileSync(tiny, await sharp({ create: { width: 100, height: 150, channels: 3, background: '#c33' } }).jpeg().toBuffer());
  assert.equal(await caps.writeVariant(tiny), 'written');
  assert.equal((await sharp(path.join(dir, 'sm', 'poster.webp')).metadata()).width, 100);
});

test('every show-image URL the site uses has its variant on disk (advisory mirror of --check-variants)', () => {
  const root = new URL('../../public/images/shows/', import.meta.url).pathname;
  if (!fs.existsSync(root)) return;
  const missing = [];
  for (const d of fs.readdirSync(root)) {
    for (const role of ['poster', 'thumbnail']) {
      const has = ['webp', 'jpg', 'jpeg', 'png'].some(e => fs.existsSync(path.join(root, d, `${role}.${e}`)));
      if (has && !fs.existsSync(path.join(root, d, 'sm', `${role}.webp`))) missing.push(`${d}/${role}`);
    }
  }
  if (missing.length) console.warn(`::warning::${missing.length} show images lack an sm/ variant, e.g. ${missing.slice(0, 3).join(', ')}`);
});
