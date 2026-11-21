import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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

test('variantPathFor maps canonical poster/thumbnail to sm/<file>.webp, ignores everything else', () => {
  assert.equal(caps.variantPathFor('/x/show/poster.jpg'), path.join('/x/show', 'sm', 'poster.jpg.webp'));
  assert.equal(caps.variantPathFor('/x/show/thumbnail.png'), path.join('/x/show', 'sm', 'thumbnail.png.webp'));
  assert.equal(caps.variantPathFor('/x/show/poster.webp'), path.join('/x/show', 'sm', 'poster.webp.webp'));
  assert.equal(caps.variantPathFor('/x/show/hero.webp'), null);
  assert.equal(caps.variantPathFor('/x/show/thumbnail-v2.webp'), null);
});

test('writeVariant shrinks to the role width, never enlarges, is idempotent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'variants-'));
  const big = path.join(dir, 'thumbnail.webp');
  fs.writeFileSync(big, await sharp({ create: { width: 540, height: 540, channels: 3, background: '#39c' } }).webp().toBuffer());
  assert.equal(await caps.writeVariant(big), 'written');
  assert.equal((await sharp(path.join(dir, 'sm', 'thumbnail.webp.webp')).metadata()).width, caps.VARIANT_WIDTHS.thumbnail);
  assert.equal(await caps.writeVariant(big), 'skipped');
  const tiny = path.join(dir, 'poster.jpg');
  fs.writeFileSync(tiny, await sharp({ create: { width: 100, height: 150, channels: 3, background: '#c33' } }).jpeg().toBuffer());
  assert.equal(await caps.writeVariant(tiny), 'written');
  assert.equal((await sharp(path.join(dir, 'sm', 'poster.jpg.webp')).metadata()).width, 100);
});

test('every show-image URL the site uses has its variant on disk (advisory mirror of --check-variants)', () => {
  const root = new URL('../../public/images/shows/', import.meta.url).pathname;
  if (!fs.existsSync(root)) return;
  const missing = [];
  for (const d of fs.readdirSync(root)) {
    for (const role of ['poster', 'thumbnail']) {
      for (const e of ['webp', 'jpg', 'jpeg', 'png']) {
        if (fs.existsSync(path.join(root, d, `${role}.${e}`)) && !fs.existsSync(path.join(root, d, 'sm', `${role}.${e}.webp`))) missing.push(`${d}/${role}.${e}`);
      }
    }
  }
  if (missing.length) console.warn(`::warning::${missing.length} show images lack an sm/ variant, e.g. ${missing.slice(0, 3).join(', ')}`);
});

test('a jpg and a webp original in one dir get separate variants; a placeholder drops its variant', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'variants2-'));
  const mk = (w, c) => sharp({ create: { width: w, height: w, channels: 3, background: c } });
  fs.writeFileSync(path.join(dir, 'thumbnail.jpg'), await mk(300, '#c33').jpeg().toBuffer());
  fs.writeFileSync(path.join(dir, 'thumbnail.webp'), await mk(540, '#39c').webp().toBuffer());
  await caps.writeVariant(path.join(dir, 'thumbnail.jpg'));
  await caps.writeVariant(path.join(dir, 'thumbnail.webp'));
  assert.equal((await sharp(path.join(dir, 'sm', 'thumbnail.jpg.webp')).metadata()).width, 240);
  assert.equal((await sharp(path.join(dir, 'sm', 'thumbnail.webp.webp')).metadata()).width, 240);
  caps.removeVariant(path.join(dir, 'thumbnail.jpg'));
  assert.ok(!fs.existsSync(path.join(dir, 'sm', 'thumbnail.jpg.webp')));
  assert.ok(fs.existsSync(path.join(dir, 'sm', 'thumbnail.webp.webp')));
});

test('LOCAL_SHOW_IMAGE accepts the ?v=<hash> that BRO-6197 appends and carries it onto the variant', () => {
  const m = /const LOCAL_SHOW_IMAGE = (\/.*\/i);/.exec(tsSrc);
  const re = eval(m[1]);
  const hit = re.exec('/images/shows/x-2024/poster.webp?v=9e8a06b8');
  assert.ok(hit, 'versioned URL must still match, or the homepage silently loses srcset');
  assert.equal(hit[4], '?v=9e8a06b8');
  assert.ok(re.exec('/images/shows/x-2024/thumbnail.jpg'));
  assert.equal(re.exec('/images/shows/x-2024/hero.webp?v=1'), null);
  assert.equal(re.exec('/images/shows/x-2024/poster.webp?foo=bar'), null);
});

test('server srcset helper never builds an fs path from process.cwd() (traces public/ into serverless bundles, broke prod deploys)', () => {
  const src = fs.readFileSync(new URL('../../src/lib/show-image-srcset.server.ts', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/process\.cwd\(\)|from 'fs'|from 'path'/.test(src));
});

test('trace guard flags a function that traces public/images', () => {
  const { checkNft } = require('./check-coverage-floor-trace.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nft-'));
  fs.mkdirSync(path.join(dir, '.next'));
  const nft = path.join(dir, '.next', 'x.js.nft.json');
  fs.writeFileSync(nft, JSON.stringify({ version: 1, files: ['../data/coverage-floor-snapshot.json', '../public/images/shows/a/sm/poster.webp.webp'] }));
  const bad = checkNft(nft, dir);
  assert.ok(bad.problems.some(p => p.includes('public/images')));
  fs.writeFileSync(nft, JSON.stringify({ version: 1, files: ['../data/coverage-floor-snapshot.json'] }));
  assert.ok(!checkNft(nft, dir).problems.some(p => p.includes('public/images')));
});

test('every <ShowImage> in src passes sizes so local images use the small sm/ variant (BRO-6327)', () => {
  const root = fileURLToPath(new URL('../../src/', import.meta.url));
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : /\.tsx$/.test(e.name) ? [path.join(d, e.name)] : []);
  const missing = [];
  for (const f of walk(root)) {
    if (f.endsWith(path.join('components', 'ShowImage.tsx'))) continue;
    const s = fs.readFileSync(f, 'utf8');
    // Put sizes before any fallback={<.../>}: the match stops at the first '/>'.
    for (const m of s.matchAll(/<ShowImage\b([\s\S]*?)\/>/g)) {
      if (!/\bsizes=/.test(m[1]) && !/sizes-ok:/.test(s.slice(Math.max(0, m.index - 200), m.index))) {
        missing.push(`${path.relative(root, f)}:${s.slice(0, m.index).split('\n').length}`);
      }
    }
  }
  assert.deepEqual(missing, [], 'add sizes="..." (or a {/* sizes-ok: reason */} comment just above) to: ' + missing.join(', '));
});
