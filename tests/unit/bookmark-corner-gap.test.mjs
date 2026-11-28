import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Regression pin for the "bookmark floats too far from the thumbnail corner"
// bug that recurred 3+ times (owner, Oct 2026). Cause: globals.css forces every
// <button> to min 44x44 on mobile, so the 28x32 glyph box sat centered in a
// 44x44 button and the top/right offsets were off by 6-8px.
const src = readFileSync(new URL('../../src/components/user/ShowPageBookmark.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../src/app/globals.css', import.meta.url), 'utf8');

const corner = src.match(/const CORNER_BUTTON = (["'])(.*?)\1;/s)?.[2] ?? '';
const sm = corner;

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

test('tap area is 44x44 (28x32 glyph box + 16px left + 12px down), not clipped smaller', () => {
  assert.match(sm, /after:absolute/);
  assert.match(sm, /after:-left-4/);
  assert.match(sm, /after:-bottom-3/);
});

test('sm AND compact both use the corner button (compact was inflated the same way in the mobile hero)', () => {
  assert.match(src, /sm:\s*\{\s*button:\s*CORNER_BUTTON/);
  assert.match(src, /compact:\s*\{\s*button:\s*CORNER_BUTTON/);
});

// Keyboard users tabbing across cards on desktop: the unsaved bookmark is
// sm:opacity-0 until hover, so focus must reveal it and show a ring (the ring is
// inset because the thumbnail's overflow-hidden would crop an outer one).
test('unsaved sm bookmark becomes visible and ringed on keyboard focus', () => {
  assert.match(src, /sm:focus-visible:opacity-100/);
  assert.match(src, /focus-visible:ring-2/);
  assert.match(src, /focus-visible:ring-inset/);
});
