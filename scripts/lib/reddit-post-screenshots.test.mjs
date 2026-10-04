// BRO-4597: phone-shaped screenshot clipping for the Reddit post email.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { clipRect, cleanCut, MAX_ASPECT, captureShowImages } = require('./reddit-post-screenshots.js');

test('a short card is padded and kept whole', () => {
  const c = clipRect({ x: 16, y: 100, width: 398, height: 300 }, 430);
  assert.deepEqual(c, { x: 4, y: 88, width: 422, height: 324 });
});

test('padding never leaves the page', () => {
  const c = clipRect({ x: 0, y: 0, width: 430, height: 200 }, 430);
  assert.equal(c.x, 0);
  assert.equal(c.y, 0);
  assert.equal(c.width, 430);
});

test('a tall card ends in a gap between sections, never through text', () => {
  const box = { x: 16, y: 100, width: 398, height: 1400 };
  const blocks = [
    { top: 100, bottom: 300 }, { top: 310, bottom: 420 },
    { top: 470, bottom: 560 }, // gap 420..470
    { top: 600, bottom: 900 }, // gap 560..600
    { top: 905, bottom: 1400 },
  ];
  const c = clipRect(box, 430, { blocks });
  assert.ok(c.height / c.width <= MAX_ASPECT + 1e-9, 'within 4:5');
  assert.equal(c.y + c.height, 580, 'cut at the midpoint of the lowest gap that fits');
});

test('no clean gap: falls back to the 4:5 limit', () => {
  const c = clipRect({ x: 16, y: 0, width: 398, height: 2000 }, 430, { blocks: [{ top: 0, bottom: 2000 }] });
  assert.equal(c.height, Math.floor(c.width * MAX_ASPECT));
});

test('a gap too near the top is ignored (would leave a tiny image)', () => {
  const blocks = [{ top: 0, bottom: 40 }, { top: 100, bottom: 2000 }];
  const c = clipRect({ x: 16, y: 0, width: 398, height: 2000 }, 430, { blocks });
  assert.equal(c.height, Math.floor(c.width * MAX_ASPECT));
});

test('cleanCut: overlapping blocks are not a gap; small gaps are ignored', () => {
  assert.equal(cleanCut([{ top: 0, bottom: 100 }, { top: 50, bottom: 200 }, { top: 210, bottom: 300 }], 1000), null, '10px gap < minGap');
  assert.equal(cleanCut([{ top: 0, bottom: 100 }, { top: 50, bottom: 200 }, { top: 240, bottom: 300 }], 1000), 220);
  assert.equal(cleanCut([{ top: 0, bottom: 100 }, { top: 200, bottom: 300 }], 120), null, 'gap midpoint below the limit');
  assert.equal(cleanCut([], 1000), null);
});

test('captureShowImages never throws: a broken browser gives no images', async () => {
  const logs = [];
  const chromium = { launch: async () => { throw new Error('no browser here'); } };
  const out = await captureShowImages('http://example.invalid', '/tmp/x-shots', { chromium, log: m => logs.push(m) });
  assert.deepEqual(out, []);
  assert.match(logs.join('\n'), /screenshots skipped \(no browser here\)/);
});
