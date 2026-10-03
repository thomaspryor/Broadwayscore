/**
 * BRO-3221: the matinee/evening/custom showtime icons on mobile watchlist
 * cards were 12px glyphs in 16px buttons, too small to read or tap. The
 * compact picker now uses 20px buttons with 14px glyphs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE = readFileSync(join(ROOT, 'src/components/user/ShowtimePicker.tsx'), 'utf8');

// Tailwind spacing scale: w-N is N * 4px.
const px = (cls) => Number(cls.match(/^[wh]-(\d+(?:\.\d+)?)$/)[1]) * 4;

test('compact showtime buttons are at least 20px square', () => {
  const start = SOURCE.indexOf('const iconBtn = ');
  assert.ok(start !== -1, 'iconBtn class builder not found in CompactShowtimePicker');
  const cls = SOURCE.slice(start, SOURCE.indexOf('`;', start));
  const w = cls.match(/\bw-\d+(?:\.\d+)?\b/)[0];
  const h = cls.match(/\bh-\d+(?:\.\d+)?\b/)[0];
  assert.ok(px(w) >= 20, `button width ${w} is under 20px`);
  assert.ok(px(h) >= 20, `button height ${h} is under 20px`);
});

test('showtime glyphs are at least 14px', () => {
  for (const name of ['SunIcon', 'MoonIcon', 'ClockIcon', 'ClearIcon']) {
    const start = SOURCE.indexOf(`function ${name}()`);
    assert.ok(start !== -1, `${name} not found`);
    const svg = SOURCE.slice(start, SOURCE.indexOf('>', SOURCE.indexOf('<svg', start)));
    const [, w, h] = svg.match(/className="(w-[\d.]+) (h-[\d.]+)"/);
    assert.ok(px(w) >= 14 && px(h) >= 14, `${name} glyph ${w} ${h} is under 14px`);
  }
});
