import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Regression pin for the "bookmark floats too far from the thumbnail corner"
// bug that recurred 3+ times (owner, Oct 2026). Cause: globals.css forces every
// <button> to min 44x44 on mobile, so the 28x32 glyph box sat centered in a
// 44x44 button and the top/right offsets were off by 6-8px.
const src = readFileSync(new URL('../../src/components/user/ShowPageBookmark.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../src/app/globals.css', import.meta.url), 'utf8');

const sm = src.match(/sm:\s*\{\s*button:\s*(["'])(.*?)\1/s)?.[2] ?? '';

test('global mobile rule still inflates every button to 44px (so the opt-out is needed)', () => {
  assert.match(css, /button,\s*a,\s*\[role="button"\]\s*\{[^}]*min-height:\s*44px/s);
});

test('sm bookmark opts out of the global 44px minimum so offsets are exact', () => {
  assert.match(sm, /(^|\s)min-h-0(\s|$)/);
  assert.match(sm, /(^|\s)min-w-0(\s|$)/);
});

test('sm bookmark uses non-negative corner offsets (glyph padding already supplies the gap)', () => {
  assert.match(sm, /(^|\s)top-0(\s|$)/);
  assert.match(sm, /(^|\s)right-0(\s|$)/);
  assert.doesNotMatch(sm, /(^|\s)-(top|right)-/);
});

test('sm bookmark keeps a 44px tap area via ::after', () => {
  assert.match(sm, /after:absolute/);
  assert.match(sm, /after:-inset-2/);
});
