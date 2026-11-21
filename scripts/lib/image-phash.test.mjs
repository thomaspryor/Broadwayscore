import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const P = require('./image-phash.js');

// Deterministic pseudo-random picture: blobs of light on dark, no sharp needed.
function picture(seed, w = 96, h = 128) {
  let s = seed >>> 0;
  const rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  const blobs = Array.from({ length: 9 }, () => ({ x: rnd() * w, y: rnd() * h, r: 8 + rnd() * 22, v: 60 + rnd() * 195 }));
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 20;
      for (const b of blobs) {
        const d = Math.hypot(x - b.x, y - b.y);
        if (d < b.r) v = Math.max(v, b.v * (1 - d / b.r / 1.6));
      }
      data[y * w + x] = Math.min(255, Math.round(v));
    }
  }
  return { data, width: w, height: h };
}
const brighten = (r, k, add) => ({ ...r, data: r.data.map((v) => Math.max(0, Math.min(255, Math.round(v * k + add)))) });
const noisy = (r, amp, seed) => {
  let s = seed >>> 0;
  return { ...r, data: r.data.map((v) => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return Math.max(0, Math.min(255, v + Math.round(((s >>> 16) / 65536 - 0.5) * amp))); }) };
};

test('cropBox is centred and has the requested aspect', () => {
  const b = P.cropBox(100, 100, 2 / 3);
  assert.equal(b.h, 100);
  assert.equal(b.w, 67);
  assert.equal(b.x, 16);
  const wide = P.cropBox(200, 100, 1);
  assert.deepEqual([wide.w, wide.h, wide.x, wide.y], [100, 100, 50, 0]);
});

test('a flat or empty raster has no signature', () => {
  assert.equal(P.signatureFromGray({ data: new Uint8Array(64 * 64).fill(128), width: 64, height: 64 }), null);
  assert.equal(P.signatureFromGray({ data: null, width: 0, height: 0 }), null);
  assert.equal(P.similarity(null, P.signatureFromGray(picture(1))), -1);
});

test('the same picture scores ~1 after brightness, contrast and noise changes', () => {
  const base = P.signatureFromGray(picture(7));
  assert.ok(P.similarity(base, base) > 0.999);
  const edited = P.signatureFromGray(noisy(brighten(picture(7), 0.8, 25), 18, 3));
  assert.ok(P.similarity(base, edited) > 0.95, `got ${P.similarity(base, edited)}`);
});

test('different pictures score well below the lookalike threshold', () => {
  const a = P.signatureFromGray(picture(7));
  for (const seed of [11, 23, 42, 99, 123]) {
    const sim = P.similarity(a, P.signatureFromGray(picture(seed)));
    assert.ok(sim < 0.9, `seed ${seed} scored ${sim}`);
  }
});

test('a differently shaped crop of the same picture still matches on a shared aspect', () => {
  const big = picture(5, 120, 160); // 3:4
  const base = P.signatureFromGray(big);
  const cropped = P.signatureFromGray({ data: Uint8Array.from({ length: 120 * 120 }, (_, i) => big.data[(Math.floor(i / 120) + 20) * 120 + (i % 120)]), width: 120, height: 120 });
  assert.ok(P.similarity(base, cropped) > 0.85, `got ${P.similarity(base, cropped)}`);
});

test('hamming counts differing bits', () => {
  assert.equal(P.hamming({ hi: 0, lo: 0 }, { hi: 0xffffffff, lo: 1 }), 33);
  assert.equal(P.hamming({ hi: 5, lo: 9 }, { hi: 5, lo: 9 }), 0);
});

test('signatureOf reads a real image buffer with one grey channel (sharp)', async () => {
  const sharp = require('sharp');
  const { data, width, height } = picture(7);
  const png = await sharp(Buffer.from(data), { raw: { width, height, channels: 1 } }).png().toBuffer();
  const sig = await P.signatureOf(png);
  assert.ok(sig && sig.sq);
  const again = await P.signatureOf(await sharp(png).resize(48, 64).jpeg({ quality: 60 }).toBuffer());
  assert.ok(P.similarity(sig, again) > 0.9, `got ${P.similarity(sig, again)}`);
  assert.equal(await P.signatureOf(Buffer.from('not an image')), null);
});
