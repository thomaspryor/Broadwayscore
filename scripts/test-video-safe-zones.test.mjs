// Pins the per-channel safe zones (owner, 2026-11-01: TikTok's chrome covered the logo, captions and right edge).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { ZONES, CHANNELS, zone, fit, layout, NATIVE, CAP_H, CAP_GAP } = require('./video-proto/safe-zones.js');

// a full-frame scene like the voiced formats: logo at the top, cards down to ~480
const SCENE = { left: 20, top: 32, right: 344, bottom: 523 };

test('every channel the video scheduler posts to has a safe zone', () => {
  const py = fs.readFileSync(new URL('./video-proto/schedule-compare-short.py', import.meta.url), 'utf8');
  const chs = [...py.matchAll(/'(\w+)': '[0-9a-f]{24}'/g)].map((m) => m[1]);
  assert.ok(chs.length >= 4);
  for (const c of chs) assert.ok(ZONES[c], `no safe zone for ${c}`);
});

test('TikTok keeps clear of the search bar, the button column and the caption block (owner screenshot)', () => {
  const z = zone('tiktok');
  assert.ok(z.top >= 81 + 10, 'search bar ends ~81 stage px down; keep a margin');
  assert.ok(z.right <= 302 - 10, 'button column starts ~302 stage px across; keep a margin');
  assert.ok(z.bottom <= 560 - 40, 'account name starts ~560 stage px down; shorter phones cover more');
  assert.ok(z.left >= 14, 'tall phones crop ~14 stage px off each side');
});

for (const ch of CHANNELS) {
  test(`${ch}: scene and captions land inside the safe area, never overlapping`, () => {
    const F = fit(SCENE, ch), z = F.zone;
    const placed = { left: F.x + SCENE.left * F.s, top: F.y + SCENE.top * F.s, right: F.x + SCENE.right * F.s, bottom: F.y + SCENE.bottom * F.s };
    assert.ok(placed.left >= z.left - 0.1 && placed.right <= z.right + 0.1);
    assert.ok(placed.top >= z.top - 0.1);
    assert.ok(placed.bottom <= F.cap.top + 0.1, 'scene runs into the caption block');
    assert.equal(F.cap.bottom, z.bottom);
    assert.ok(Math.abs(F.cap.bottom - F.cap.top - CAP_H) < 0.01);
    assert.ok(F.s > 0.55, `scene shrunk to ${F.s}, too small to read`);
  });
}

test('a scene that already fits is never enlarged', () => {
  assert.equal(fit({ left: 100, top: 200, right: 200, bottom: 260 }, 'tiktok').s, 1);
});

test('silent formats get the whole safe area', () => {
  assert.equal(fit(SCENE, 'tiktok', { withCaptions: false }).cap, null);
  assert.ok(fit(SCENE, 'tiktok', { withCaptions: false }).s > fit(SCENE, 'tiktok').s);
});

test('an unknown channel stops the render', () => assert.throws(() => zone('myspace'), /no safe zone/));

for (const ch of CHANNELS) {
  test(`${ch}: the layout box for redesigned formats sits inside the safe area, above the captions`, () => {
    const L = layout(ch), z = zone(ch);
    assert.equal(L.x, z.left); assert.equal(L.y, z.top);
    assert.ok(Math.abs(L.x + L.w - z.right) < 0.01);
    assert.ok(Math.abs(L.y + L.h - (z.bottom - CAP_H - CAP_GAP)) < 0.01);
    assert.ok(L.w >= 260 && L.h >= 300, `box ${L.w}x${L.h} too small for the verdict and compare layouts`);
  });
}
test('verdict, versus and compare are laid out for each app, not shrunk', () => {
  for (const f of ['verdict', 'versus', 'compare']) assert.ok(NATIVE.has(f));
});
