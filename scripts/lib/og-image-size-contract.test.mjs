/**
 * Contract guard: show OG images must ship as small JPEGs.
 *
 * 2026-09-29: link previews for /show/* did not appear in WhatsApp. The OG image
 * was a full-bleed photo encoded as PNG by next/og (~1.2 MB); WhatsApp drops
 * previews whose image is over ~300 KB. The fix re-encodes every ImageResponse
 * through toJpeg() (sharp) and declares image/jpeg (~70-80 KB).
 *
 * Source-string structural checks (the route imports Next/React, so it can't be
 * require()d here). Every `new ImageResponse(` must sit inside `toJpeg(`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(join(ROOT, 'src/app/show/[slug]/opengraph-image.tsx'), 'utf8');

test('show OG image declares image/jpeg, not image/png', () => {
  assert.match(src, /export const contentType = 'image\/jpeg'/);
  assert.doesNotMatch(src, /export const contentType = 'image\/png'/);
});

test('every ImageResponse is wrapped in toJpeg()', () => {
  const total = (src.match(/new ImageResponse\(/g) || []).length;
  const wrapped = (src.match(/toJpeg\(new ImageResponse\(/g) || []).length;
  assert.ok(total >= 2, 'expected the main and fallback ImageResponse');
  assert.equal(wrapped, total, 'a bare ImageResponse would emit a >1 MB PNG');
});

test('toJpeg re-encodes with sharp at a size-safe quality', () => {
  assert.match(src, /from 'sharp'/);
  const q = Number(/\.jpeg\(\{[^}]*quality:\s*(\d+)/.exec(src)?.[1]);
  assert.ok(q > 0 && q <= 85, `JPEG quality ${q} should stay <= 85 to keep the file under 300 KB`);
});
