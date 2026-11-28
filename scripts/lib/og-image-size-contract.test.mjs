/**
 * Wiring guard: show OG images must ship as small JPEGs (BRO-4395).
 *
 * 2026-09-29: link previews for /show/* did not appear in WhatsApp. The OG image
 * was a full-bleed photo encoded as PNG by next/og (~1.2 MB); WhatsApp drops
 * previews whose image is over ~300 KB. The behavior of the re-encode itself
 * (JPEG bytes, < 300 KB, dimensions, PNG fallback) is tested against the real
 * helper in tests/unit/og-jpeg.test.ts. This file only pins the route's wiring,
 * which a helper test cannot see: the route imports Next/React, so it can't be
 * require()d here. Every `new ImageResponse(` must sit inside
 * `pngToOgJpegResponse(` or a bare one would serve a >1 MB PNG again.
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

test('every ImageResponse is wrapped in pngToOgJpegResponse()', () => {
  const total = (src.match(/new ImageResponse\(/g) || []).length;
  const wrapped = (src.match(/pngToOgJpegResponse\(\s*new ImageResponse\(/g) || []).length;
  assert.ok(total >= 2, 'expected the main and fallback ImageResponse');
  assert.equal(wrapped, total, 'a bare ImageResponse would emit a >1 MB PNG');
});

test('route imports the real helper from src/lib/og-jpeg', () => {
  assert.match(src, /import \{ pngToOgJpegResponse \} from '@\/lib\/og-jpeg'/);
});
